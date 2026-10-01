import { describe, expect, it } from "vitest";
import { ChunkReader } from "../engine/chunkstore.js";
import { packPrefix } from "../engine/layout.js";
import { noopLogger } from "../engine/logger.js";
import { SnapshotWriter } from "../engine/snapshot.js";
import type { ChunkIndex, ChunkLocation } from "../engine/types.js";
import type { ManifestObject } from "../manifest.js";
import { type CatalogPack, MemoryPackCatalog, type PackCatalog } from "./catalog.js";
import {
  DEFAULT_SUPERSEDED_GRACE_MS,
  type GcBlocker,
  type ScrubEnvironment,
  isGcBlocker,
} from "./gc.js";
import { sampleSizeFor, selectPacks } from "./integrity.js";
import { seededRandom } from "./random.js";
import { type ScrubOptions, type ScrubReport, runScrub, scrubFindingDetails } from "./scrub.js";
import {
  type MemoryStorage,
  type StoreFixture,
  createStoreFixture,
  fixtureBytes,
  mailboxItems,
  writeSnapshot,
} from "./testing.js";

const HOUR = 3_600_000;

type ScrubFixture = StoreFixture & {
  objects: ManifestObject[];
  catalog: MemoryPackCatalog;
  env: (catalog?: PackCatalog) => ScrubEnvironment;
};

async function scrubFixture(copies = 0, mails = 24): Promise<ScrubFixture> {
  const fixture = createStoreFixture({ copies });
  const { objects } = await writeSnapshot(fixture, mailboxItems(mails, 0), 4 * 1024);
  const catalog = new MemoryPackCatalog(fixture.index);
  const env = (override?: PackCatalog): ScrubEnvironment => ({
    tenantId: fixture.ctx.tenantId,
    storage: fixture.storage,
    keys: fixture.ctx.keys,
    catalog: override ?? catalog,
    logger: noopLogger,
    signal: new AbortController().signal,
    now: () => fixture.clock.now,
  });
  return { ...fixture, objects, catalog, env };
}

function scrub(fixture: ScrubFixture, options: Partial<ScrubOptions> = {}, catalog?: PackCatalog) {
  return runScrub(fixture.env(catalog), fixture.ctx.progress, {
    mode: "full",
    gc: { cutoff: new Date(fixture.clock.now.getTime() + HOUR) },
    ...options,
  });
}

async function packKeys(fixture: StoreFixture): Promise<string[]> {
  return fixture.primary.list(packPrefix(fixture.ctx.tenantId));
}

async function catalogPaths(fixture: ScrubFixture): Promise<string[]> {
  return (await fixture.catalog.listPacks()).map((pack) => pack.path).sort();
}

/**
 * The next scrub, `hoursLater` after the previous one: it continues from the
 * superseded packs the previous report left pending, as the worker does.
 */
function nextScrub(
  fixture: ScrubFixture,
  previous: ScrubReport,
  hoursLater: number,
  options: Partial<ScrubOptions> = {},
) {
  fixture.clock.now = new Date(fixture.clock.now.getTime() + hoursLater * HOUR);
  return scrub(fixture, { previouslySuperseded: previous.superseded.pending, ...options });
}

/** A chunk index frozen at the moment a reader looked its chunks up. */
async function frozenIndex(fixture: StoreFixture, ids: readonly string[]): Promise<ChunkIndex> {
  const snapshot: Map<string, ChunkLocation> = await fixture.index.locate(ids);
  return {
    existing: async () => new Set(),
    recordPack: async () => {},
    locate: async (wanted) =>
      new Map(
        wanted.flatMap((id) => {
          const location = snapshot.get(id);
          return location ? [[id, location] as const] : [];
        }),
      ),
    addReferences: async () => {},
    releaseReferences: async () => {},
  };
}

async function readsBackExactly(fixture: ScrubFixture, objects: readonly ManifestObject[]) {
  const reader = new ChunkReader({
    storage: fixture.storage,
    keys: fixture.ctx.keys,
    index: fixture.index,
  });
  for (const object of objects) {
    // readObjectToBuffer checks the size and the whole-object SHA-256.
    await reader.readObjectToBuffer(object);
  }
}

describe("scrub integrity", () => {
  it("passes every pack of an intact store", async () => {
    const fixture = await scrubFixture();
    const report = await scrub(fixture, { gc: null });
    expect(report.packsTotal).toBeGreaterThan(3);
    expect(report.packsChecked).toBe(report.packsTotal);
    expect(report.ok).toBe(report.packsTotal);
    expect(report.corrupt).toEqual([]);
    expect(report.repaired).toEqual([]);
    expect(report.gc).toEqual({ status: "skipped", reason: "disabled" });
  });

  it("detects a corrupted pack and names the cause", async () => {
    const fixture = await scrubFixture();
    const [victim] = await packKeys(fixture);
    fixture.primary.flipByte(victim as string, 200);

    const report = await scrub(fixture);
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0]).toMatchObject({
      path: victim,
      status: "corrupt",
      targets: [{ target: 0, status: "hash_mismatch", repaired: false }],
    });
    expect(report.ok).toBe(report.packsTotal - 1);
    expect(fixture.ctx.progressSink.failures.map((failure) => failure.itemRef)).toEqual([victim]);
    expect(report.gc.status).toBe("completed");
  });

  it("never re-packs a damaged pack, even when all of it is unreferenced", async () => {
    const fixture = await scrubFixture();
    await fixture.index.releaseReferences(fixture.objects.flatMap((object) => object.chunks));
    const [victim] = await packKeys(fixture);
    fixture.primary.flipByte(victim as string, 200);

    const report = await scrub(fixture);
    expect(report.corrupt.map((pack) => pack.path)).toEqual([victim]);
    expect(report.gc).toMatchObject({
      status: "completed",
      skipped: [{ path: victim, reason: "damaged pack left untouched" }],
    });
    // Every other pack was collected; the damaged one stays as evidence.
    expect(await catalogPaths(fixture)).toEqual([victim]);
    await nextScrub(fixture, report, 25);
    expect(await packKeys(fixture)).toEqual([victim]);
  });

  it("marks proven damage, lets the next backup write the content again and retires the healed pack", async () => {
    const fixture = await scrubFixture();
    const [victim] = await packKeys(fixture);
    fixture.primary.flipByte(victim as string, 200);

    const first = await scrub(fixture, { gc: null });
    expect(first.corrupt.map((pack) => pack.path)).toEqual([victim]);
    const marked = (await fixture.catalog.listPacks()).find((pack) => pack.path === victim);
    expect(marked?.damagedAt).toEqual(fixture.clock.now);
    const held = (await fixture.catalog.chunksOf(marked?.id as string)).map((c) => c.storedId);
    expect(held.length).toBeGreaterThan(0);
    // Its chunks no longer count as stored, so a backup does not reuse them.
    expect(await fixture.index.existing(held)).toEqual(new Set());

    // A full backup reads every item from the source again.
    await writeSnapshot(fixture, mailboxItems(24, 0), 4 * 1024);
    expect(await fixture.catalog.chunksOf(marked?.id as string)).toEqual([]);
    await readsBackExactly(
      fixture,
      fixture.objects.filter((object) => object.chunks.length > 0),
    );

    const second = await scrub(fixture, { gc: null });
    expect(second.corrupt).toEqual([]);
    expect(second.retired).toEqual([victim]);
    expect(await catalogPaths(fixture)).not.toContain(victim);
    expect(second.superseded.pending.map((pack) => pack.path)).toContain(victim);
  });

  it("clears the damage mark of a pack that checks intact again", async () => {
    const fixture = await scrubFixture();
    const [victim] = await packKeys(fixture);
    const intact = await fixture.primary.get(victim as string);
    fixture.primary.flipByte(victim as string, 200);
    await scrub(fixture, { gc: null });
    await fixture.primary.put(victim as string, intact);

    const report = await scrub(fixture, { mode: "sample", gc: null });
    expect(report.corrupt).toEqual([]);
    expect((await fixture.catalog.listPacks()).every((pack) => !pack.damagedAt)).toBe(true);
  });

  it("marks nothing damaged when not a single pack is intact (an outage, not damage)", async () => {
    const fixture = await scrubFixture();
    for (const key of await packKeys(fixture)) {
      await fixture.primary.delete(key);
    }
    const report = await scrub(fixture, { gc: null });
    expect(report.corrupt).toHaveLength(report.packsTotal);
    expect((await fixture.catalog.listPacks()).every((pack) => !pack.damagedAt)).toBe(true);
  });

  it("repairs a damaged primary from an intact copy", async () => {
    const fixture = await scrubFixture(1);
    const [victim] = await packKeys(fixture);
    const intact = await fixture.copies[0]?.get(victim as string);
    fixture.primary.flipByte(victim as string, -60);

    const report = await scrub(fixture, { gc: null });
    expect(report.corrupt).toEqual([]);
    expect(report.repaired).toHaveLength(1);
    expect(report.repaired[0]?.targets).toEqual([
      expect.objectContaining({ target: 0, status: "hash_mismatch", repaired: true }),
      { target: 1, status: "ok", detail: null, repaired: false },
    ]);
    expect((await fixture.primary.get(victim as string)).equals(intact as Buffer)).toBe(true);
  });

  it("restores a pack that vanished from the copy", async () => {
    const fixture = await scrubFixture(1);
    const [victim] = await packKeys(fixture);
    await fixture.copies[0]?.delete(victim as string);

    const report = await scrub(fixture, { gc: null });
    expect(report.repaired[0]?.targets[1]).toMatchObject({ status: "missing", repaired: true });
    expect(await fixture.copies[0]?.head(victim as string)).not.toBeNull();
  });

  it("reports a pack missing everywhere as corrupt", async () => {
    const fixture = await scrubFixture();
    const [victim] = await packKeys(fixture);
    await fixture.primary.delete(victim as string);
    const report = await scrub(fixture, { gc: null });
    expect(report.corrupt[0]?.targets[0]).toMatchObject({ status: "missing" });
  });

  it("detects a truncated pack", async () => {
    const fixture = await scrubFixture();
    const [victim] = await packKeys(fixture);
    const bytes = await fixture.primary.get(victim as string);
    await fixture.primary.put(victim as string, bytes.subarray(0, bytes.length - 10));
    const report = await scrub(fixture, { gc: null });
    expect(report.corrupt[0]?.targets[0]).toMatchObject({ status: "size_mismatch" });
  });

  it("detects drift between the chunk index and the pack", async () => {
    const fixture = await scrubFixture();
    const [id, entry] = [...fixture.index.chunks.entries()][0] ?? [];
    fixture.index.chunks.set(id as string, { ...(entry as NonNullable<typeof entry>), offset: 3 });
    const report = await scrub(fixture, { gc: null });
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0]?.targets[0]).toMatchObject({ status: "index_mismatch" });
  });

  it("samples a share of the packs and always re-checks known damage", async () => {
    const packs: CatalogPack[] = Array.from({ length: 400 }, (_, i) => ({
      id: `p${i}`,
      path: `tenants/t/packs/00/p${i}`,
      sha256: "",
      size: 1,
      createdAt: new Date(0),
    }));
    expect(sampleSizeFor(400)).toBe(20);
    expect(sampleSizeFor(10)).toBe(10);
    const selected = selectPacks(
      packs,
      "sample",
      seededRandom(3),
      new Set(["tenants/t/packs/00/p399"]),
    );
    expect(selected).toHaveLength(20);
    expect(selected[0]?.path).toBe("tenants/t/packs/00/p399");
    expect(new Set(selected.map((pack) => pack.id)).size).toBe(20);
    expect(selectPacks(packs, "full", seededRandom(3))).toHaveLength(400);
  });

  it("never collects garbage on a sample run", async () => {
    const fixture = await scrubFixture();
    const report = await scrub(fixture, { mode: "sample", seed: 5 });
    expect(report.seed).toBe(5);
    expect(report.gc).toEqual({ status: "skipped", reason: "sample_run" });
    expect(report.orphans).toBeNull();
  });
});

describe("scrub garbage collection", () => {
  async function releaseEveryOther(fixture: ScrubFixture): Promise<ManifestObject[]> {
    const released = fixture.objects.filter((object, i) => object.chunks.length > 0 && i % 2 === 0);
    await fixture.index.releaseReferences(released.flatMap((object) => object.chunks));
    return released;
  }

  it("re-packs unreferenced chunks into new packs and keeps every live object restorable", async () => {
    const fixture = await scrubFixture();
    const released = await releaseEveryOther(fixture);
    const live = fixture.objects.filter(
      (object) => object.chunks.length > 0 && !released.includes(object),
    );
    const before = await packKeys(fixture);

    const report = await scrub(fixture);
    if (report.gc.status !== "completed") {
      throw new Error(`gc did not run: ${JSON.stringify(report.gc)}`);
    }
    expect(report.gc.chunksDropped).toBe(released.length);
    expect(report.gc.packsRewritten).toBeGreaterThan(0);
    expect(report.gc.bytesReclaimed).toBeGreaterThan(0);
    expect(report.gc.conflicts).toBe(0);

    for (const object of released) {
      expect(fixture.index.chunks.has(object.chunks[0] as string)).toBe(false);
    }
    await readsBackExactly(fixture, live);

    // Never rewritten in place: the catalog points at new packs only, and the
    // old files wait out their grace period untouched.
    const catalog = await catalogPaths(fixture);
    expect(catalog.some((key) => before.includes(key))).toBe(false);
    const superseded = report.superseded.pending.map((pack) => pack.path);
    expect(superseded.length).toBe(report.gc.packsRewritten + report.gc.packsRemoved);
    expect(superseded.every((key) => before.includes(key))).toBe(true);
    expect((await packKeys(fixture)).sort()).toEqual([...catalog, ...superseded].sort());

    // A day later they are gone, and every surviving key is new.
    const later = await nextScrub(fixture, report, 25);
    expect(later.superseded).toEqual({
      released: superseded.length,
      releasedBytes: report.superseded.pending.reduce((sum, pack) => sum + pack.size, 0),
      pending: [],
    });
    expect((await packKeys(fixture)).sort()).toEqual(await catalogPaths(fixture));
    await readsBackExactly(fixture, live);
  });

  it("removes a pack outright when nothing in it is referenced", async () => {
    const fixture = await scrubFixture();
    await fixture.index.releaseReferences(fixture.objects.flatMap((object) => object.chunks));
    const report = await scrub(fixture);
    expect(report.gc).toMatchObject({ status: "completed", packsRewritten: 0 });
    expect(fixture.index.packs.size).toBe(0);
    await nextScrub(fixture, report, 25);
    expect(await packKeys(fixture)).toEqual([]);
  });

  it("deletes swapped-out packs right away when the grace period is zero", async () => {
    const fixture = await scrubFixture();
    await releaseEveryOther(fixture);
    const report = await scrub(fixture, {
      gc: { cutoff: new Date(fixture.clock.now.getTime() + HOUR), supersededGraceMs: 0 },
    });
    expect(report.gc).toMatchObject({ status: "completed", superseded: [] });
    expect(report.superseded.pending).toEqual([]);
    expect((await packKeys(fixture)).sort()).toEqual(await catalogPaths(fixture));
  });

  it("leaves chunks that lost their reference only recently", async () => {
    const fixture = await scrubFixture();
    const released = await releaseEveryOther(fixture);
    for (const object of released) {
      fixture.catalog.touchChunk(object.chunks[0] as string, fixture.clock.now);
    }
    const report = await scrub(fixture, {
      gc: { cutoff: new Date(fixture.clock.now.getTime() - HOUR) },
    });
    expect(report.gc).toMatchObject({ status: "completed", chunksDropped: 0 });
  });

  it("keeps chunks of a checkpointed snapshot that is not committed yet", async () => {
    const fixture = await scrubFixture();
    const writer = await SnapshotWriter.begin(fixture.ctx, {
      protectedObject: fixture.protectedObject,
      sourceType: "m365",
      maxPackBytes: 4 * 1024,
    });
    const pending = await writer.chunks.write(fixtureBytes(900, 4242));
    writer.add({
      path: "mail/Inbox/new.eml",
      size: pending.size,
      mtime: 0,
      type: "mail",
      chunks: pending.chunks,
    });
    await writer.checkpoint();
    expect(fixture.index.chunks.get(pending.chunks[0] as string)?.refcount).toBe(0);

    const report = await scrub(fixture);
    expect(report.gc.status).toBe("completed");
    expect(fixture.index.chunks.has(pending.chunks[0] as string)).toBe(true);
  });

  it.each<GcBlocker>(["backup_running", "restore_running", "verify_running"])(
    "does not start while a job of the tenant is running (%s)",
    async (blocker) => {
      const fixture = await scrubFixture();
      await releaseEveryOther(fixture);
      const before = (await packKeys(fixture)).sort();
      const catalogBefore = await catalogPaths(fixture);
      const report = await scrub(fixture, {
        gc: {
          cutoff: new Date(fixture.clock.now.getTime() + HOUR),
          blockedBy: async () => blocker,
        },
      });
      expect(report.gc).toEqual({ status: "skipped", reason: blocker });
      expect(report.orphans).toBeNull();
      expect((await packKeys(fixture)).sort()).toEqual(before);
      expect(await catalogPaths(fixture)).toEqual(catalogBefore);
    },
  );

  it("deletes no pack a restore or verify that is running reads", async () => {
    const fixture = await scrubFixture();
    const released = await releaseEveryOther(fixture);
    const live = fixture.objects.filter(
      (object) => object.chunks.length > 0 && !released.includes(object),
    );
    // A restore resolved where its chunks live, then collection swaps the
    // packs underneath it: the locations it holds must stay readable.
    const reader = new ChunkReader({
      storage: fixture.storage,
      keys: fixture.ctx.keys,
      index: await frozenIndex(
        fixture,
        live.flatMap((object) => object.chunks),
      ),
    });
    const report = await scrub(fixture);
    expect(report.gc).toMatchObject({ status: "completed" });
    if (report.gc.status === "completed") {
      expect(report.gc.packsRewritten).toBeGreaterThan(0);
    }
    for (const object of live) {
      await reader.readObjectToBuffer(object);
    }

    // Within the grace period a full run keeps them; the orphan sweep does
    // too, although the files were written long ago.
    for (const pack of report.superseded.pending) {
      fixture.primary.setModified(pack.path, new Date(fixture.clock.now.getTime() - 48 * HOUR));
    }
    const early = await nextScrub(fixture, report, 1);
    expect(early.superseded).toEqual({
      released: 0,
      releasedBytes: 0,
      pending: report.superseded.pending,
    });
    expect(early.orphans?.removed).toBe(0);

    // Past the grace period, nothing goes while a restore or verify of the
    // tenant is running.
    let previous = early;
    for (const blocker of ["restore_running", "verify_running"] as const) {
      const busy = await nextScrub(fixture, previous, blocker === "restore_running" ? 24 : 0, {
        gc: {
          cutoff: new Date(fixture.clock.now.getTime() + HOUR),
          blockedBy: async () => blocker,
        },
      });
      expect(busy.gc).toEqual({ status: "skipped", reason: blocker });
      expect(busy.superseded).toEqual({
        released: 0,
        releasedBytes: 0,
        pending: report.superseded.pending,
      });
      previous = busy;
    }
    for (const object of live) {
      await reader.readObjectToBuffer(object);
    }

    // Once nothing runs, the next run (a sample run will do) releases them.
    const due = await nextScrub(fixture, previous, 0, { mode: "sample", seed: 1 });
    expect(due.superseded.released).toBe(report.superseded.pending.length);
    expect(due.superseded.pending).toEqual([]);
    expect((await packKeys(fixture)).sort()).toEqual(await catalogPaths(fixture));
    await readsBackExactly(fixture, live);
  });

  it("keeps superseded packs while collection is disabled, and never deletes a live pack", async () => {
    const fixture = await scrubFixture();
    await releaseEveryOther(fixture);
    const report = await scrub(fixture);
    const [live] = await catalogPaths(fixture);
    const pending = [
      ...report.superseded.pending,
      // A path the catalog knows must never be released, whatever the list says.
      { path: live as string, size: 1, supersededAt: "2026-01-01T00:00:00.000Z" },
    ];
    const disabled = await nextScrub(fixture, report, 48, {
      gc: null,
      previouslySuperseded: pending,
    });
    expect(disabled.superseded).toEqual({ released: 0, releasedBytes: 0, pending });

    const released = await nextScrub(fixture, disabled, 1);
    expect(released.superseded.released).toBe(report.superseded.pending.length);
    expect(released.superseded.pending).toEqual([]);
    expect(await packKeys(fixture)).toContain(live);
  });

  it("names every job kind collection yields to", () => {
    expect(isGcBlocker("restore_running")).toBe(true);
    expect(isGcBlocker("verify_running")).toBe(true);
    expect(isGcBlocker("backup_running")).toBe(true);
    expect(isGcBlocker("sample_run")).toBe(false);
    expect(isGcBlocker(null)).toBe(false);
    expect(DEFAULT_SUPERSEDED_GRACE_MS).toBe(24 * HOUR);
  });

  it("stops between packs as soon as a backup starts", async () => {
    const fixture = await scrubFixture();
    await releaseEveryOther(fixture);
    let asked = 0;
    const report = await scrub(fixture, {
      gc: {
        cutoff: new Date(fixture.clock.now.getTime() + HOUR),
        // Clear at the start and for the first pack, then a backup begins.
        blockedBy: async () => (++asked > 2 ? "backup_running" : null),
      },
    });
    expect(report.gc).toMatchObject({ status: "completed", interruptedBy: "backup_running" });
    if (report.gc.status === "completed") {
      expect(report.gc.packsRewritten + report.gc.packsRemoved).toBe(1);
    }
    await readsBackExactly(
      fixture,
      fixture.objects.filter((object, i) => object.chunks.length > 0 && i % 2 === 1),
    );
  });

  it("refuses to collect while a checkpointed snapshot cannot be read", async () => {
    const fixture = await scrubFixture();
    await fixture.primary.put(
      `tenants/${fixture.ctx.tenantId}/manifests/x.partial`,
      Buffer.from("junk"),
    );
    const report = await scrub(fixture);
    expect(report.gc).toEqual({ status: "skipped", reason: "partial_manifest_unreadable" });
  });

  it("deletes an unreadable checkpoint nothing can resume instead of refusing to collect", async () => {
    const fixture = await scrubFixture();
    await releaseEveryOther(fixture);
    const junk = `tenants/${fixture.ctx.tenantId}/manifests/x.partial`;
    await fixture.primary.put(junk, Buffer.from("junk"));
    const asked: string[] = [];
    const report = await scrub(fixture, {
      gc: {
        cutoff: new Date(fixture.clock.now.getTime() + HOUR),
        abandonedCheckpoint: async (snapshotId) => {
          asked.push(snapshotId);
          return true;
        },
      },
    });
    expect(asked).toEqual(["x"]);
    expect(report.gc).toMatchObject({ status: "completed" });
    if (report.gc.status === "completed") {
      expect(report.gc.chunksDropped).toBeGreaterThan(0);
    }
    expect(await fixture.primary.head(junk)).toBeNull();
  });

  it("reclaims the chunks of an abandoned checkpoint, and keeps those of a resumable one", async () => {
    const checkpointed = async (fixture: ScrubFixture, seed: number) => {
      const writer = await SnapshotWriter.begin(fixture.ctx, {
        protectedObject: fixture.protectedObject,
        sourceType: "m365",
        maxPackBytes: 4 * 1024,
      });
      const pending = await writer.chunks.write(fixtureBytes(900, seed));
      writer.add({
        path: `mail/Inbox/${seed}.eml`,
        size: pending.size,
        mtime: 0,
        type: "mail",
        chunks: pending.chunks,
      });
      const checkpoint = await writer.checkpoint();
      return { chunk: pending.chunks[0] as string, checkpoint };
    };

    // The job that wrote it ended for good: the checkpoint goes, its chunk too.
    const dead = await scrubFixture();
    const abandoned = await checkpointed(dead, 4243);
    const deadReport = await scrub(dead, {
      gc: {
        cutoff: new Date(dead.clock.now.getTime() + HOUR),
        abandonedCheckpoint: async (id) => id === abandoned.checkpoint.snapshotId,
      },
    });
    expect(deadReport.gc.status).toBe("completed");
    expect(dead.index.chunks.has(abandoned.chunk)).toBe(false);
    expect(await dead.primary.head(abandoned.checkpoint.partialKey)).toBeNull();

    // A retry may still resume it: the checkpoint and its chunk stay.
    const live = await scrubFixture();
    const resumable = await checkpointed(live, 4244);
    const liveReport = await scrub(live, {
      gc: {
        cutoff: new Date(live.clock.now.getTime() + HOUR),
        abandonedCheckpoint: async () => false,
      },
    });
    expect(liveReport.gc.status).toBe("completed");
    expect(live.index.chunks.has(resumable.chunk)).toBe(true);
    expect(await live.primary.head(resumable.checkpoint.partialKey)).not.toBeNull();
  });

  it("cancels a swap when a chunk regains a reference and leaves the old pack authoritative", async () => {
    const fixture = await scrubFixture();
    const released = await releaseEveryOther(fixture);
    const racing: PackCatalog = {
      listPacks: () => fixture.catalog.listPacks(),
      chunksOf: (id) => fixture.catalog.chunksOf(id),
      collectablePacks: (cutoff) => fixture.catalog.collectablePacks(cutoff),
      setDamaged: (ids, at) => fixture.catalog.setDamaged(ids, at),
      retireDamagedPack: (pack) => fixture.catalog.retireDamagedPack(pack),
      async replacePack(change) {
        // A backup deduplicates against a condemned chunk and commits first.
        await fixture.index.addReferences(change.dropped.slice(0, 1));
        return fixture.catalog.replacePack(change);
      },
    };
    const before = (await packKeys(fixture)).sort();

    const report = await scrub(fixture, {}, racing);
    expect(report.gc).toMatchObject({ status: "completed", packsRewritten: 0, packsRemoved: 0 });
    if (report.gc.status === "completed") {
      expect(report.gc.conflicts).toBeGreaterThan(0);
    }
    // The replacement files were withdrawn, the originals untouched.
    expect((await packKeys(fixture)).sort()).toEqual(before);
    await readsBackExactly(
      fixture,
      fixture.objects.filter((object) => object.chunks.length > 0),
    );
    expect(released.length).toBeGreaterThan(0);
  });

  it("keeps the old pack when its replacement does not read back intact", async () => {
    const fixture = await scrubFixture(1);
    await releaseEveryOther(fixture);
    const before = (await packKeys(fixture)).sort();
    // From now on the copy target silently corrupts everything written to it.
    const copy = fixture.copies[0] as MemoryStorage;
    const put = copy.put.bind(copy);
    copy.put = async (key, data) => {
      await put(key, data);
      copy.flipByte(key, 40);
    };

    const report = await scrub(fixture);
    if (report.gc.status !== "completed") {
      throw new Error("gc did not run");
    }
    expect(report.gc.packsRewritten).toBe(0);
    expect(report.gc.skipped.length).toBeGreaterThan(0);
    expect(report.gc.skipped[0]?.reason).toMatch(/replacement not confirmed/);
    // Nothing was deleted, and no half-written replacement is left behind.
    expect((await packKeys(fixture)).sort()).toEqual(before);
    expect((await copy.list(packPrefix(fixture.ctx.tenantId))).sort()).toEqual(before);
    await readsBackExactly(
      fixture,
      fixture.objects.filter((object) => object.chunks.length > 0),
    );
  });

  it("sweeps orphaned pack files once they are older than the grace period", async () => {
    const fixture = await scrubFixture();
    const prefix = packPrefix(fixture.ctx.tenantId);
    await fixture.primary.put(`${prefix}ab/orphan-old`, Buffer.from("left over"));
    fixture.primary.setModified(
      `${prefix}ab/orphan-old`,
      new Date(fixture.clock.now.getTime() - 48 * HOUR),
    );
    await fixture.primary.put(`${prefix}cd/orphan-new`, Buffer.from("being written"));

    const report = await scrub(fixture);
    expect(report.orphans).toEqual({ removed: 1, bytes: 9, kept: 1 });
    expect(await fixture.primary.head(`${prefix}ab/orphan-old`)).toBeNull();
    expect(await fixture.primary.head(`${prefix}cd/orphan-new`)).not.toBeNull();
  });
});

describe("scrubFindingDetails", () => {
  it("files a red storage_corrupt reason naming the packs", () => {
    const details = scrubFindingDetails("job-1", [
      {
        packId: "p1",
        path: "tenants/t/packs/ab/p1",
        size: 10,
        status: "corrupt",
        targets: [{ target: 0, status: "hash_mismatch", detail: null, repaired: false }],
      },
    ]);
    expect(details).toMatchObject({
      origin: "scrub",
      kind: "health_check",
      reasons: [{ code: "storage_corrupt", severity: "red", count: 1 }],
      packs: [{ path: "tenants/t/packs/ab/p1" }],
    });
  });
});
