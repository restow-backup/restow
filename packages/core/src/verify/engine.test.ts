import { describe, expect, it } from "vitest";
import { manifestKey } from "../engine/layout.js";
import { noopLogger } from "../engine/logger.js";
import { sealManifest } from "../engine/sealed-manifest.js";
import { loadManifest } from "../engine/snapshot.js";
import type { ChunkIndex, ChunkLocation, RestoreEngine, RestoreRequest } from "../engine/types.js";
import { FailureError, buildCause } from "../failures/classify.js";
import type { FailureCause } from "../failures/types.js";
import type { ManifestObject } from "../manifest.js";
import { PackReader, PackWriter } from "../pack.js";
import { MemoryPackCatalog } from "./catalog.js";
import { damagedPacksOfSnapshot, verifyProtectedObject } from "./engine.js";
import { VerifyIncompleteError } from "./errors.js";
import type { ScrubEnvironment } from "./gc.js";
import { restoreEngineProbe } from "./probe.js";
import { runScrub } from "./scrub.js";
import {
  type FixtureItem,
  type MemoryStorage,
  type StoreFixture,
  createStoreFixture,
  mailboxItems,
  writeSnapshot,
} from "./testing.js";

const HOUR = 3_600_000;

async function mailboxFixture(mails = 30): Promise<StoreFixture & { objects: ManifestObject[] }> {
  const fixture = createStoreFixture();
  const { objects } = await writeSnapshot(fixture, mailboxItems(mails));
  return { ...fixture, objects };
}

function verify(
  fixture: StoreFixture,
  overrides: Partial<Parameters<typeof verifyProtectedObject>[2]> = {},
) {
  return verifyProtectedObject(fixture.ctx, fixture.protectedObject, {
    kind: "verify",
    sampleSize: 20,
    seed: 11,
    ...overrides,
  });
}

/** Every chunk of the snapshot, so a test can damage exactly what a check will read. */
function allChunkIds(objects: readonly ManifestObject[]): string[] {
  return objects.flatMap((object) => object.chunks);
}

describe("verifyProtectedObject", () => {
  it("rates a healthy, current snapshot green after reading the sample back byte-exact", async () => {
    const fixture = await mailboxFixture();
    const outcome = await verify(fixture);

    expect(outcome.readiness).toBe("green");
    expect(outcome.details.reasons).toEqual([]);
    expect(outcome.details.counts.sampled).toEqual({ mail: 20, file: 0, event: 3, contact: 3 });
    expect(outcome.details.counts.eligible).toEqual({ mail: 30, file: 0, event: 3, contact: 3 });
    expect(outcome.checked).toBe(26);
    expect(outcome.details.counts.verified).toBe(26);
    expect(outcome.details.items.every((item) => item.objectHash === "matched")).toBe(true);
    expect(outcome.details.seed).toBe(11);
    expect(outcome.details.snapshot?.sequence).toBe(1);
    expect(fixture.ctx.progressSink.failures).toEqual([]);
  });

  it("reports a missing snapshot as red", async () => {
    const fixture = createStoreFixture();
    const outcome = await verify(fixture);
    expect(outcome.readiness).toBe("red");
    expect(outcome.details.reasons).toEqual([{ code: "no_snapshot", severity: "red" }]);
    expect(outcome.details.snapshot).toBeNull();
    expect(outcome.checked).toBe(0);
  });

  it("detects a chunk that is gone from the chunk index", async () => {
    const fixture = await mailboxFixture(5);
    for (const id of allChunkIds(fixture.objects)) {
      fixture.index.chunks.delete(id);
    }
    const outcome = await verify(fixture);
    expect(outcome.readiness).toBe("red");
    expect(outcome.details.counts.missing).toBe(outcome.checked);
    expect(outcome.missing).toBe(outcome.checked);
    expect(outcome.details.reasons[0]).toMatchObject({ code: "items_missing", severity: "red" });
    expect(outcome.details.items[0]?.reason).toMatch(/not in the chunk index/);
    // Every failed item says why, in the shared vocabulary.
    expect(outcome.details.items[0]?.cause).toMatchObject({ code: "verify.chunk_missing" });
    expect(fixture.ctx.progressSink.failures[0]?.cause?.code).toBe("verify.chunk_missing");
  });

  it("detects a damaged pack as unreadable (authenticated decryption fails)", async () => {
    const fixture = await mailboxFixture(5);
    for (const key of await fixture.primary.list(`tenants/${fixture.ctx.tenantId}/packs/`)) {
      // Past the pack header: inside the first sealed chunk.
      fixture.primary.flipByte(key, 120);
    }
    const outcome = await verify(fixture);
    expect(outcome.readiness).toBe("red");
    expect(outcome.details.counts.unreadable).toBeGreaterThan(0);
    expect(outcome.details.reasons.map((reason) => reason.code)).toContain("items_unreadable");
    expect(fixture.ctx.progressSink.failures.length).toBe(outcome.details.counts.unreadable);
    // A pack that fails authenticated decryption is a key or damage problem, named as such.
    const causes = outcome.details.items.flatMap((item) => (item.cause ? [item.cause.code] : []));
    expect(causes.length).toBeGreaterThan(0);
    expect(
      causes.every((code) => code === "crypto.key_invalid" || code === "verify.pack_unreadable"),
    ).toBe(true);
  });

  it("detects a pack file that disappeared from storage", async () => {
    const fixture = await mailboxFixture(5);
    for (const key of await fixture.primary.list(`tenants/${fixture.ctx.tenantId}/packs/`)) {
      await fixture.primary.delete(key);
    }
    const outcome = await verify(fixture);
    // The storage answered "not found" for a pack the index names: the data is missing.
    expect(outcome.readiness).toBe("red");
    expect(outcome.details.counts.missing).toBe(outcome.checked);
    expect(outcome.details.reasons[0]).toMatchObject({ code: "items_missing", severity: "red" });
    expect(outcome.details.items[0]?.reason).toMatch(/not readable from any storage target/);
    expect(outcome.details.items[0]?.cause).toMatchObject({ code: "verify.chunk_missing" });
  });

  it("takes an S3 NoSuchKey (404) as missing data, never a missing bucket", async () => {
    const s3 = (name: string) => () =>
      Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
    const gone = await mailboxFixture(3);
    gone.primary.failReads(`tenants/${gone.ctx.tenantId}/packs/`, s3("NoSuchKey"));
    expect((await verify(gone)).details.reasons[0]).toMatchObject({ code: "items_missing" });

    const bucket = await mailboxFixture(3);
    bucket.primary.failReads(`tenants/${bucket.ctx.tenantId}/packs/`, s3("NoSuchBucket"));
    await expect(verify(bucket)).rejects.toBeInstanceOf(VerifyIncompleteError);
  });

  it("detects chunks that decrypt fine but are not the chunks the manifest names", async () => {
    const fixture = await mailboxFixture(4);
    // Rewrite every pack so each index entry points at its neighbour's sealed
    // bytes: authenticated decryption still succeeds (each sealed blob carries
    // its own id), only re-addressing the plaintext can tell.
    for (const key of await fixture.primary.list(`tenants/${fixture.ctx.tenantId}/packs/`)) {
      const original = PackReader.open(await fixture.primary.get(key));
      const entries = original.entries();
      const shuffled = new PackWriter(fixture.ctx.tenantId);
      for (const [i, entry] of entries.entries()) {
        const neighbour = entries[(i + 1) % entries.length] as (typeof entries)[number];
        shuffled.append(entry.storedId, original.get(neighbour.storedId) as Buffer);
      }
      await fixture.primary.put(key, shuffled.finalize());
    }

    const outcome = await verify(fixture);
    const mismatched = outcome.details.items.filter((item) => item.status === "mismatch");
    expect(mismatched.length).toBeGreaterThan(0);
    expect(mismatched[0]?.reason).toMatch(/content address/);
    expect(mismatched[0]?.cause).toMatchObject({ code: "verify.hash_mismatch" });
    expect(outcome.readiness).toBe("red");
  });

  it("detects an object whose bytes differ from the manifest hash", async () => {
    const fixture = await mailboxFixture(3);
    const record = await fixture.snapshots.latestCompleted(fixture.protectedObject.id);
    const key = record?.manifestPath as string;
    const manifest = await loadManifest(fixture.storage, key, fixture.ctx.keys);
    const tampered = manifest.objects.find((object) => object.type === "mail") as ManifestObject;
    tampered.sha256 = "0".repeat(64);
    await fixture.primary.put(key, await sealManifest(manifest, fixture.ctx.keys.current, key));

    const outcome = await verify(fixture);
    const check = outcome.details.items.find((item) => item.path === tampered.path);
    expect(check).toMatchObject({ status: "mismatch", objectHash: "mismatched" });
    expect(check?.reason).toMatch(/SHA-256/);
    expect(check?.cause).toMatchObject({ code: "verify.hash_mismatch" });
    expect(outcome.mismatched).toBe(1);
    expect(outcome.details.reasons).toContainEqual({
      code: "items_mismatched",
      severity: "red",
      count: 1,
    });
  });

  it("re-addresses chunks even when the manifest carries no object hash", async () => {
    const fixture = await mailboxFixture(3);
    const record = await fixture.snapshots.latestCompleted(fixture.protectedObject.id);
    const key = record?.manifestPath as string;
    const manifest = await loadManifest(fixture.storage, key, fixture.ctx.keys);
    manifest.objects = manifest.objects.map(({ sha256: _dropped, ...object }) => object);
    await fixture.primary.put(key, await sealManifest(manifest, fixture.ctx.keys.current, key));

    const outcome = await verify(fixture);
    expect(outcome.readiness).toBe("green");
    expect(outcome.details.items.every((item) => item.objectHash === "not_recorded")).toBe(true);
  });

  it("reports an unreadable manifest as red", async () => {
    const fixture = await mailboxFixture(3);
    const record = await fixture.snapshots.latestCompleted(fixture.protectedObject.id);
    await fixture.primary.put(record?.manifestPath as string, Buffer.from([0x07, 0x01, 0x02]));
    const outcome = await verify(fixture);
    expect(outcome.readiness).toBe("red");
    expect(outcome.details.reasons.map((reason) => reason.code)).toEqual(["manifest_unreadable"]);
    expect(outcome.details.snapshot?.id).toBe(record?.id);
    // Why the manifest cannot be read (a broken file, a wrong key, an unreachable storage) is kept.
    expect(outcome.details.manifestCause?.code).toMatch(
      /^(verify\.manifest_unreadable|crypto\.key_invalid)$/,
    );
    expect(fixture.ctx.progressSink.failures[0]?.cause?.code).toBe(
      outcome.details.manifestCause?.code,
    );
  });

  it("turns yellow when the latest backup is getting old and red when it is outdated", async () => {
    const fixture = await mailboxFixture(3);
    const completed = fixture.clock.now.getTime();

    fixture.clock.now = new Date(completed + 60 * HOUR);
    const stale = await verify(fixture);
    expect(stale.readiness).toBe("yellow");
    expect(stale.details.reasons).toEqual([
      { code: "snapshot_stale", severity: "yellow", ageHours: 60 },
    ]);

    fixture.clock.now = new Date(completed + 8 * 24 * HOUR);
    const outdated = await verify(fixture);
    expect(outdated.readiness).toBe("red");
    expect(outdated.details.reasons[0]).toMatchObject({ code: "snapshot_outdated", ageHours: 192 });
  });

  it("turns yellow when the snapshot holds nothing that can be verified", async () => {
    const fixture = createStoreFixture();
    await writeSnapshot(fixture, [{ path: "mail/Inbox", type: "folder", size: 0 }]);
    const outcome = await verify(fixture);
    expect(outcome.readiness).toBe("yellow");
    expect(outcome.details.reasons).toEqual([{ code: "nothing_to_verify", severity: "yellow" }]);
  });

  it("marks the object red when the scrub found one of its packs corrupt", async () => {
    const fixture = await mailboxFixture(3);
    const record = await fixture.snapshots.latestCompleted(fixture.protectedObject.id);
    const manifest = await loadManifest(
      fixture.storage,
      record?.manifestPath as string,
      fixture.ctx.keys,
    );
    const damaged = manifest.packs?.[0] as string;
    const outcome = await verify(fixture, {
      damagedPacks: new Set([damaged, "tenants/x/packs/aa/other"]),
    });
    expect(outcome.readiness).toBe("red");
    expect(outcome.details.damagedPacks).toEqual([damaged]);
    expect(outcome.details.reasons).toContainEqual({
      code: "storage_corrupt",
      severity: "red",
      count: 1,
    });
  });

  it("reads every object in a health check and lists only the failures", async () => {
    const fixture = await mailboxFixture(40);
    const victim = fixture.objects.find((object) => object.path === "mail/Inbox/17.eml");
    fixture.index.chunks.delete(victim?.chunks[0] as string);

    const outcome = await verify(fixture, { kind: "health_check" });
    expect(outcome.details.scope).toBe("all");
    expect(outcome.details.seed).toBeNull();
    expect(outcome.checked).toBe(46);
    expect(outcome.details.items.map((item) => item.path)).toEqual(["mail/Inbox/17.eml"]);
    expect(outcome.details.itemsOmitted).toBe(45);
    expect(outcome.readiness).toBe("red");
  });

  it("stops on cancellation instead of recording findings", async () => {
    const fixture = await mailboxFixture(3);
    const controller = new AbortController();
    controller.abort();
    const ctx = { ...fixture.ctx, signal: controller.signal };
    await expect(
      verifyProtectedObject(ctx, fixture.protectedObject, { kind: "verify", sampleSize: 5 }),
    ).rejects.toThrow(/aborted/);
  });
});

describe("a check that cannot read the data rates nothing", () => {
  const socket = (code: string) => () =>
    Object.assign(new Error(`connect ${code} 10.0.0.5:9000`), {
      code,
      syscall: "connect",
      address: "10.0.0.5",
      port: 9000,
    });
  const s3 = (name: string, status: number) => () =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it.each([
    ["the storage refuses connections", socket("ECONNREFUSED"), "storage.unreachable"],
    ["a connection is reset", socket("ECONNRESET"), "storage.unreachable"],
    ["the name does not resolve", socket("ENOTFOUND"), "storage.unreachable"],
    ["a read times out", socket("ETIMEDOUT"), "storage.timeout"],
    ["S3 answers 503", s3("ServiceUnavailable", 503), "storage.rate_limited"],
    ["S3 throttles (429)", s3("TooManyRequests", 429), "storage.rate_limited"],
    ["S3 answers 500", s3("InternalError", 500), "storage.error"],
    ["an error nobody knows", () => new Error("something odd"), "verify.incomplete"],
  ])("is incomplete, not red, when %s", async (_name, error, code) => {
    const fixture = await mailboxFixture(5);
    fixture.primary.failReads(`tenants/${fixture.ctx.tenantId}/packs/`, error);
    const thrown = await verify(fixture).catch((failure: unknown) => failure);
    expect(thrown).toBeInstanceOf(VerifyIncompleteError);
    const incomplete = thrown as VerifyIncompleteError;
    expect(incomplete.failure).toMatchObject({ code, transient: true });
    expect(incomplete.message).toMatch(/could not complete and will be retried/);
    // Nothing was recorded as a finding, and the storage was asked once, not for every item.
    expect(fixture.ctx.progressSink.failures).toEqual([]);
  });

  it("is incomplete when the manifest cannot be read, even when the storage says it is gone", async () => {
    const unreachable = await mailboxFixture(3);
    unreachable.primary.failReads(
      `tenants/${unreachable.ctx.tenantId}/manifests/`,
      socket("ECONNREFUSED"),
    );
    await expect(verify(unreachable)).rejects.toBeInstanceOf(VerifyIncompleteError);

    // An unmounted share or an emptied target says "not found" for the first object as well.
    const gone = await mailboxFixture(3);
    for (const key of await gone.primary.list(`tenants/${gone.ctx.tenantId}/manifests/`)) {
      await gone.primary.delete(key);
    }
    await expect(verify(gone)).rejects.toBeInstanceOf(VerifyIncompleteError);
  });

  it("rates a manifest that does not decode red", async () => {
    const fixture = await mailboxFixture(3);
    for (const key of await fixture.primary.list(`tenants/${fixture.ctx.tenantId}/manifests/`)) {
      fixture.primary.flipByte(key, -3);
    }
    const outcome = await verify(fixture);
    expect(outcome.readiness).toBe("red");
    expect(outcome.details.reasons[0]).toMatchObject({ code: "manifest_unreadable" });
  });

  it("keeps red with evidence found before the storage stopped answering", async () => {
    const fixture = await mailboxFixture(5);
    // Every chunk index entry is gone (evidence, read from the database), then the storage fails.
    for (const id of allChunkIds(fixture.objects)) {
      fixture.index.chunks.delete(id);
    }
    fixture.primary.failReads(`tenants/${fixture.ctx.tenantId}/packs/`, socket("ECONNREFUSED"));
    const outcome = await verify(fixture);
    expect(outcome.readiness).toBe("red");
    expect(outcome.details.reasons[0]).toMatchObject({ code: "items_missing" });
  });

  it("is incomplete for an old backup it could not read: too old is no proof of damage", async () => {
    const fixture = await mailboxFixture(3);
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 10 * 24 * HOUR);
    fixture.primary.failReads(`tenants/${fixture.ctx.tenantId}/packs/`, socket("ECONNREFUSED"));
    await expect(verify(fixture)).rejects.toBeInstanceOf(VerifyIncompleteError);
  });

  it("reads from a copy when the primary does not answer, and never calls that missing", async () => {
    const fixture = createStoreFixture({ copies: 1 });
    await writeSnapshot(fixture, mailboxItems(3));
    const copy = fixture.copies[0] as MemoryStorage;
    expect((await copy.list(`tenants/${fixture.ctx.tenantId}/packs/`)).length).toBeGreaterThan(0);
    fixture.primary.failReads(`tenants/${fixture.ctx.tenantId}/packs/`, socket("ECONNREFUSED"));
    expect((await verify(fixture)).readiness).toBe("green");

    // The copy says "not found", the primary did not answer: nothing is known.
    for (const key of await copy.list(`tenants/${fixture.ctx.tenantId}/packs/`)) {
      await copy.delete(key);
    }
    await expect(verify(fixture)).rejects.toBeInstanceOf(VerifyIncompleteError);
  });
});

describe("test restore probe", () => {
  function fakeEngine(
    outcome: (path: string) => "confirmed" | "unconfirmed" | "failed",
    cause?: FailureCause,
  ) {
    const requests: RestoreRequest[] = [];
    const engine: RestoreEngine = {
      kind: "mailbox",
      async run(_ctx, request) {
        requests.push(request);
        const paths = request.selection.paths ?? [];
        const items = paths.map((path) => ({
          path,
          status: outcome(path) === "failed" ? "failed" : "restored",
          verified: outcome(path) === "confirmed",
          reason: outcome(path) === "confirmed" ? undefined : "target said no",
          ...(outcome(path) === "failed" && cause ? { cause } : {}),
        }));
        return {
          restored: items.filter((item) => item.status === "restored").length,
          skipped: 0,
          bytes: 0,
          failures: [],
          items,
        };
      },
    };
    return { engine, requests };
  }

  it("restores the verified sample into the test target and stays green when confirmed", async () => {
    const fixture = await mailboxFixture(5);
    const { engine, requests } = fakeEngine(() => "confirmed");
    const outcome = await verify(fixture, {
      probe: restoreEngineProbe(engine, "verify@example.org"),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.target).toEqual({ type: "other", ref: "verify@example.org" });
    expect(requests[0]?.mode).toBe("rename");
    expect(requests[0]?.selection.paths).toHaveLength(outcome.checked);
    expect(outcome.details.testRestore?.items.every((item) => item.status === "confirmed")).toBe(
      true,
    );
    expect(outcome.readiness).toBe("green");
  });

  it("turns yellow for unconfirmed and red for failed test restores", async () => {
    const fixture = await mailboxFixture(5);
    const unconfirmed = fakeEngine((path) =>
      path.endsWith("0.eml") ? "unconfirmed" : "confirmed",
    );
    const yellow = await verify(fixture, {
      probe: restoreEngineProbe(unconfirmed.engine, "verify@example.org"),
    });
    expect(yellow.readiness).toBe("yellow");
    expect(yellow.details.reasons).toContainEqual({
      code: "test_restore_unconfirmed",
      severity: "yellow",
      count: 1,
    });

    // The target refused an item for good (a permission): red.
    const failing = fakeEngine(
      (path) => (path.endsWith("1.eml") ? "failed" : "confirmed"),
      buildCause("graph.permission_missing"),
    );
    const red = await verify(fixture, {
      probe: restoreEngineProbe(failing.engine, "verify@example.org"),
    });
    expect(red.readiness).toBe("red");
    expect(red.details.reasons[0]).toMatchObject({ code: "test_restore_failed", count: 1 });
  });

  it.each([
    ["throttled", buildCause("graph.throttled")],
    ["a cause nobody classified", undefined],
  ])(
    "is incomplete when the test restore failed only for a reason that proves nothing: %s",
    async (_name, cause) => {
      const fixture = await mailboxFixture(5);
      const failing = fakeEngine(
        (path) => (path.endsWith("1.eml") ? "failed" : "confirmed"),
        cause,
      );
      await expect(
        verify(fixture, { probe: restoreEngineProbe(failing.engine, "verify@example.org") }),
      ).rejects.toBeInstanceOf(VerifyIncompleteError);
    },
  );

  it("records a probe that throws for good as a failed test restore, and one that throws for no known reason as incomplete", async () => {
    const fixture = await mailboxFixture(2);
    const engine = (error: Error): RestoreEngine => ({
      kind: "mailbox",
      run: async () => {
        throw error;
      },
    });
    const outcome = await verify(fixture, {
      probe: restoreEngineProbe(
        engine(
          new FailureError("mailbox verify@example.org does not exist", {
            code: "graph.user_not_found",
          }),
        ),
        "verify@example.org",
      ),
    });
    expect(outcome.readiness).toBe("red");
    expect(outcome.details.testRestore?.items[0]).toMatchObject({
      status: "failed",
      reason: "mailbox verify@example.org does not exist",
    });
    await expect(
      verify(fixture, {
        probe: restoreEngineProbe(engine(new Error("socket hang up")), "verify@example.org"),
      }),
    ).rejects.toBeInstanceOf(VerifyIncompleteError);
  });

  it("does not send damaged items to the test target", async () => {
    const fixture = await mailboxFixture(2);
    const victim = fixture.objects.find((object) => object.type === "mail") as ManifestObject;
    fixture.index.chunks.delete(victim.chunks[0] as string);
    const { engine, requests } = fakeEngine(() => "confirmed");
    await verify(fixture, { probe: restoreEngineProbe(engine, "verify@example.org") });
    expect(requests[0]?.selection.paths).not.toContain(victim.path);
  });
});

describe("damaged packs after garbage collection", () => {
  function scrubEnv(fixture: StoreFixture, catalog: MemoryPackCatalog): ScrubEnvironment {
    return {
      tenantId: fixture.ctx.tenantId,
      storage: fixture.storage,
      keys: fixture.ctx.keys,
      catalog,
      logger: noopLogger,
      signal: new AbortController().signal,
      now: () => fixture.clock.now,
    };
  }

  it("attributes a corrupt pack to the objects whose chunks it holds after a re-pack", async () => {
    const fixture = createStoreFixture();
    const anna = fixture.protectedObject;
    const ben = {
      ...fixture,
      protectedObject: {
        ...anna,
        id: "8d7c6b5a-4938-4271-8a6b-5c4d3e2f1a0b",
        externalId: "ben@example.org",
        displayName: "Ben Example",
      },
    };
    // Anna: a first snapshot with every mail, then one with every other mail
    // (deduplicated, so it writes no packs of its own). Ben: his own mails.
    const items = mailboxItems(24, 0);
    const first = await writeSnapshot(fixture, items, 4 * 1024);
    const kept: FixtureItem[] = items.filter((item, i) => item.type === "folder" || i % 2 === 1);
    await writeSnapshot(fixture, kept, 4 * 1024);
    const benItems = mailboxItems(6, 0).map((item) => ({ ...item, seed: (item.seed ?? 0) + 5000 }));
    await writeSnapshot(ben, benItems, 4 * 1024);

    // Retention prunes Anna's first snapshot; a full scrub re-packs the packs
    // that held its mails, moving the surviving chunks into new packs.
    await fixture.index.releaseReferences(first.objects.flatMap((object) => object.chunks));
    const catalog = new MemoryPackCatalog(fixture.index);
    const collected = await runScrub(scrubEnv(fixture, catalog), fixture.ctx.progress, {
      mode: "full",
      gc: { cutoff: new Date(fixture.clock.now.getTime() + HOUR) },
    });
    expect(collected.gc).toMatchObject({ status: "completed" });

    // The latest manifest still names the packs it was written into.
    const record = await fixture.snapshots.latestCompleted(anna.id);
    const manifest = await loadManifest(
      fixture.storage,
      record?.manifestPath as string,
      fixture.ctx.keys,
    );
    const liveIds = manifest.objects.flatMap((object) => object.chunks);
    const moved = [...(await fixture.index.locate(liveIds)).values()]
      .map((location) => location.packPath)
      .filter((path) => !manifest.packs?.includes(path));
    const victim = moved[0] as string;
    expect(victim).toBeDefined();

    // The scrub finds one of the new packs corrupt ...
    fixture.primary.flipByte(victim, 200);
    const scrubbed = await runScrub(scrubEnv(fixture, catalog), fixture.ctx.progress, {
      mode: "full",
      gc: null,
    });
    expect(scrubbed.corrupt.map((pack) => pack.path)).toEqual([victim]);
    const damagedPacks = new Set(scrubbed.corrupt.map((pack) => pack.path));

    // ... and verify blames Anna, whose chunks sit in it, not Ben.
    const annas = await verify(fixture, { damagedPacks });
    expect(annas.details.damagedPacks).toEqual([victim]);
    expect(annas.readiness).toBe("red");
    expect(annas.details.reasons).toContainEqual({
      code: "storage_corrupt",
      severity: "red",
      count: 1,
    });

    const bens = await verify(ben, { damagedPacks });
    expect(bens.details.damagedPacks).toEqual([]);
    expect(bens.details.reasons.map((reason) => reason.code)).not.toContain("storage_corrupt");
    expect(bens.readiness).toBe("green");
  });

  it("looks chunks up in batches and stops once every damaged pack was found", async () => {
    const batches: number[] = [];
    const index: Pick<ChunkIndex, "locate"> = {
      async locate(ids) {
        batches.push(ids.length);
        return new Map(
          ids.map((id): [string, ChunkLocation] => [
            id,
            { storedId: id, offset: 0, length: 1, packPath: id === "0003" ? "p/bad" : "p/good" },
          ]),
        );
      },
    };
    const manifest = {
      objects: Array.from({ length: 2500 }, (_, i) => ({
        path: `f/${i}`,
        size: 1,
        mtime: 0,
        chunks: [i.toString(16).padStart(4, "0")],
      })),
    };
    expect(
      await damagedPacksOfSnapshot(index as ChunkIndex, manifest, new Set(["p/bad", "p/x"])),
    ).toEqual(["p/bad"]);
    expect(batches).toEqual([1000, 1000, 500]);

    batches.length = 0;
    expect(await damagedPacksOfSnapshot(index as ChunkIndex, manifest, new Set(["p/bad"]))).toEqual(
      ["p/bad"],
    );
    expect(batches).toEqual([1000]);

    batches.length = 0;
    expect(await damagedPacksOfSnapshot(index as ChunkIndex, manifest, new Set())).toEqual([]);
    expect(batches).toEqual([]);
  });
});

describe("manifest key layout", () => {
  it("verifies the snapshot the manifest key names", async () => {
    const fixture = await mailboxFixture(1);
    const record = await fixture.snapshots.latestCompleted(fixture.protectedObject.id);
    expect(record?.manifestPath).toBe(manifestKey(fixture.ctx.tenantId, record?.id as string));
  });
});
