/**
 * The scrub handler's pure parts and its copy-target mirror: mode and GC
 * cutoff, reading earlier reports, the notifications it raises, and bringing
 * a copy target up to the primary before the integrity pass.
 *
 * The Postgres section runs the handler end to end when
 * RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
 * `restow_worker_scrub_test` is recreated there): garbage collection yields to
 * running restores and verifies of the same tenant, and swapped-out packs stay
 * readable for their grace period.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChunkIndex,
  type ChunkLocation,
  ChunkReader,
  ChunkWriter,
  Keyring,
  LocalStorageBackend,
  type ManifestObject,
  type PackCatalog,
  type PackCheck,
  type ScrubReport,
  type StorageTargets,
  type TenantMirrorReport,
  createMemoryJobContext,
  generateDek,
  manifestKey,
  noopLogger,
  packKey,
  packPrefix,
  wrappedKeyKey,
} from "@restow/core";
import {
  type Database,
  createDb,
  jobs,
  packs,
  providers,
  storageMigrations,
  storageTargets,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import { PgChunkIndex, type WorkerJobContext, tenantRunner } from "./framework.js";
import {
  GC_GRACE_HOURS,
  LegacyExcludingPackCatalog,
  SCRUB_EVENTS,
  copyMirrorSummary,
  corruptPackPathsOf,
  gcBlockerFor,
  gcBlockerOf,
  gcCutoff,
  loadKeepCutover,
  loadPreviousScrub,
  mirrorCopies,
  scrubHandler,
  scrubModeOf,
  scrubNotifications,
  supersededPacksOf,
} from "./scrub.js";

function packCheck(path: string, status: PackCheck["status"]): PackCheck {
  return { packId: randomUUID(), path, size: 1024, status, targets: [] };
}

describe("scrub helpers", () => {
  it("runs a sample scrub unless full is asked for", () => {
    expect(scrubModeOf({ mode: "full" })).toBe("full");
    expect(scrubModeOf({ mode: "sample" })).toBe("sample");
    expect(scrubModeOf({ mode: "bogus" as never })).toBe("sample");
  });

  it("lets garbage collection take only chunks unreferenced for the grace period", () => {
    const now = new Date("2026-09-23T12:00:00.000Z");
    expect(gcCutoff(now).toISOString()).toBe("2026-09-20T12:00:00.000Z");
    expect(GC_GRACE_HOURS).toBe(72);
    expect(gcCutoff(now, 1).toISOString()).toBe("2026-09-23T11:00:00.000Z");
  });

  it("reads corrupt pack paths from earlier reports of any shape", () => {
    expect(corruptPackPathsOf(null)).toEqual([]);
    expect(corruptPackPathsOf({ corrupt: "x" })).toEqual([]);
    expect(
      corruptPackPathsOf({
        corrupt: [{ path: "a" }, { path: "" }, { nope: 1 }, null, { path: "b" }],
      }),
    ).toEqual(["a", "b"]);
  });

  it("reads the superseded packs an earlier report left pending, dropping malformed entries", () => {
    const at = "2026-09-23T10:00:00.000Z";
    expect(supersededPacksOf(null)).toEqual([]);
    expect(supersededPacksOf({ gc: { status: "completed" } })).toEqual([]);
    expect(supersededPacksOf({ superseded: { pending: "x" } })).toEqual([]);
    expect(
      supersededPacksOf({
        superseded: {
          released: 2,
          pending: [
            { path: "p/1", size: 10, supersededAt: at },
            { path: "", size: 10, supersededAt: at },
            { path: "p/2", size: -1, supersededAt: at },
            { path: "p/3", size: 10, supersededAt: "yesterday-ish" },
            { path: "p/4", size: "10", supersededAt: at },
            null,
            { path: "p/5", size: 0, supersededAt: at, extra: true },
          ],
        },
      }),
    ).toEqual([
      { path: "p/1", size: 10, supersededAt: at },
      { path: "p/5", size: 0, supersededAt: at },
    ]);
  });

  it("yields garbage collection to running backups, restores and verifies", () => {
    expect(gcBlockerOf([])).toBeNull();
    expect(gcBlockerOf(["scrub", "retention", "directory"])).toBeNull();
    expect(gcBlockerOf(["restore"])).toBe("restore_running");
    expect(gcBlockerOf(["verify"])).toBe("verify_running");
    expect(gcBlockerOf(["verify", "restore"])).toBe("restore_running");
    expect(gcBlockerOf(["verify", "archive"])).toBe("backup_running");
    expect(gcBlockerOf(["backup", "restore", "verify"])).toBe("backup_running");
    expect(gcBlockerOf(["toString", "constructor"])).toBeNull();
  });

  it("raises one notification per finding kind", () => {
    const tenantId = randomUUID();
    const clean = scrubNotifications(
      tenantId,
      "job-1",
      {
        mode: "sample",
        corrupt: [],
        repaired: [],
      },
      0,
    );
    expect(clean).toEqual([]);

    const raised = scrubNotifications(
      tenantId,
      "job-2",
      {
        mode: "full",
        corrupt: [packCheck("p/1", "corrupt")],
        repaired: [packCheck("p/2", "repaired"), packCheck("p/3", "repaired")],
      },
      4,
    );
    expect(raised.map((notification) => [notification.event, notification.level])).toEqual([
      [SCRUB_EVENTS.corrupt, "error"],
      [SCRUB_EVENTS.repaired, "warning"],
    ]);
    expect(raised[0]?.details).toMatchObject({ jobId: "job-2", corrupt: 1, affectedObjects: 4 });
    expect(raised[1]?.details).toMatchObject({ repaired: 2, packs: ["p/2", "p/3"] });
  });

  it("hides packs older than a 'keep' cutover from listPacks and collectablePacks", async () => {
    const old = (path: string) => ({
      id: randomUUID(),
      path,
      size: 10,
      sha256: "a".repeat(64),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const fresh = (path: string) => ({
      id: randomUUID(),
      path,
      size: 10,
      sha256: "b".repeat(64),
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const inner: Pick<PackCatalog, "listPacks" | "collectablePacks"> = {
      listPacks: async () => [old("legacy"), fresh("current")],
      collectablePacks: async () => [old("legacy"), fresh("current")],
    };
    const catalog = new LegacyExcludingPackCatalog(
      inner as PackCatalog,
      new Date("2026-03-01T00:00:00.000Z"),
    );
    expect((await catalog.listPacks()).map((pack) => pack.path)).toEqual(["current"]);
    expect((await catalog.collectablePacks(new Date())).map((pack) => pack.path)).toEqual([
      "current",
    ]);
  });

  it("sums the mirror reports of every copy", () => {
    const copy = (copied: number, failed: number, complete: boolean) => ({
      total: 10,
      present: 10 - copied - failed,
      copied,
      repaired: 1,
      failed,
      bytesWritten: copied * 100,
      complete,
      problems: [],
      problemsOmitted: 0,
      startedAt: "2026-09-23T00:00:00.000Z",
      finishedAt: "2026-09-23T00:01:00.000Z",
    });
    const report: TenantMirrorReport = {
      copies: [copy(3, 0, true), copy(2, 1, false)],
      complete: false,
    };
    expect(copyMirrorSummary(report)).toEqual({
      copies: 2,
      complete: false,
      copied: 5,
      repaired: 2,
      failed: 1,
      bytesWritten: 500,
    });
  });
});

describe("copy-target mirror", () => {
  const tenantId = randomUUID();
  let root: string;
  let primary: LocalStorageBackend;
  let copy: LocalStorageBackend;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-scrub-mirror-"));
    primary = new LocalStorageBackend(join(root, "primary"));
    copy = new LocalStorageBackend(join(root, "copy"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context(copies: LocalStorageBackend[]) {
    return {
      tenantId,
      storage: { primary, copies },
      signal: new AbortController().signal,
      logger: noopLogger,
      now: () => new Date("2026-09-23T12:00:00.000Z"),
    };
  }

  it("does nothing for a tenant without copy targets", async () => {
    const catalog = { listPacks: async () => [] };
    expect(await mirrorCopies(context([]), catalog, "sample")).toBeNull();
  });

  it("copies keys, manifests and packs the copy is missing, then finds it complete", async () => {
    const pack = Buffer.from("pack bytes of an earlier backup");
    const packId = randomUUID();
    await primary.put(packKey(tenantId, packId), pack);
    await primary.put(manifestKey(tenantId, randomUUID()), Buffer.from("manifest"));
    await primary.put(wrappedKeyKey(tenantId, 1), Buffer.from("wrapped key"));
    const catalog = {
      listPacks: async () => [
        {
          id: packId,
          path: packKey(tenantId, packId),
          size: pack.length,
          sha256: createHash("sha256").update(pack).digest("hex"),
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ],
    };

    const first = await mirrorCopies(context([copy]), catalog, "full");
    expect(first).toMatchObject({ copies: 1, complete: true, copied: 3, failed: 0 });
    expect(await copy.get(packKey(tenantId, packId))).toEqual(pack);

    const again = await mirrorCopies(context([copy]), catalog, "sample");
    expect(again).toMatchObject({ complete: true, copied: 0, repaired: 0, bytesWritten: 0 });
  });
});

// ---------------------------------------------------------------------------
// Postgres: garbage collection next to running restores and verifies
// ---------------------------------------------------------------------------

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_scrub_test";
const HOUR = 3_600_000;

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

/** A chunk index frozen at the moment a reader looked its chunks up. */
async function frozenIndex(index: ChunkIndex, ids: readonly string[]): Promise<ChunkIndex> {
  const located: Map<string, ChunkLocation> = await index.locate(ids);
  return {
    existing: async () => new Set(),
    recordPack: async () => {},
    locate: async (wanted) =>
      new Map(
        wanted.flatMap((id) => {
          const location = located.get(id);
          return location ? [[id, location] as const] : [];
        }),
      ),
    addReferences: async () => {},
    releaseReferences: async () => {},
  };
}

/**
 * Each test writes packs, runs scrubs and reads every object back, against
 * Postgres: under a second alone, up to 2.9 s in a CI-like full run, and past
 * vitest's 5 s default when more workspaces test at once on a busy machine.
 */
const SLOW_UNDER_LOAD = { timeout: 30_000 };

describe.skipIf(!adminUrl)("garbage collection against Postgres", SLOW_UNDER_LOAD, () => {
  let db: Database;
  let root: string;
  const dek = generateDek(1);
  const keys = (tenantId: string) => new Keyring(tenantId, [dek]);

  beforeAll(async () => {
    const base = adminUrl as string;
    await withAdmin(base, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await withAdmin(base, `CREATE DATABASE ${TEST_DB}`);
    const url = new URL(base);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    root = await mkdtemp(join(tmpdir(), "restow-scrub-gc-"));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  async function createTenant(): Promise<{ tenantId: string; storage: StorageTargets }> {
    const [provider] = await db.insert(providers).values({ name: "P" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "T",
        slug: `t-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    const tenantId = tenant?.id as string;
    return {
      tenantId,
      storage: { primary: new LocalStorageBackend(join(root, tenantId)), copies: [] },
    };
  }

  async function startJob(tenantId: string, queue: "restore" | "verify" | "scrub") {
    const id = randomUUID();
    await db.insert(jobs).values({ id, tenantId, queue, status: "active", startedAt: new Date() });
    return id;
  }

  async function finishJob(tenantId: string, id: string, completedAt: Date): Promise<void> {
    await db
      .update(jobs)
      .set({ status: "completed", completedAt })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)));
  }

  /** Run the scrub handler as the worker would, at `now`, and complete its job row. */
  async function scrubAt(
    tenant: { tenantId: string; storage: StorageTargets },
    now: Date,
    mode: "full" | "sample" = "full",
  ): Promise<ScrubReport> {
    const jobId = await startJob(tenant.tenantId, "scrub");
    const ctx = {
      ...createMemoryJobContext({
        tenantId: tenant.tenantId,
        keys: keys(tenant.tenantId),
        storage: tenant.storage,
        queue: "scrub",
        jobId,
        chunkIndex: new PgChunkIndex(tenantRunner(db, tenant.tenantId), tenant.tenantId),
        now: () => now,
      }),
      db,
      protectedObject: null,
    } as WorkerJobContext;
    await scrubHandler.run(ctx, { tenantId: tenant.tenantId, jobId, mode });
    await finishJob(tenant.tenantId, jobId, now);
    const [row] = await db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, jobId));
    return (row?.payload as { result: ScrubReport }).result;
  }

  async function packFiles(tenant: { tenantId: string; storage: StorageTargets }) {
    return (await tenant.storage.primary.list(packPrefix(tenant.tenantId))).sort();
  }

  async function packRows(tenantId: string) {
    return (await db.select({ path: packs.path }).from(packs).where(eq(packs.tenantId, tenantId)))
      .map((row) => row.path)
      .sort();
  }

  /**
   * Twelve small objects in small packs; the odd ones referenced, the even
   * ones garbage. `seed` varies the content (and so the packs written) across
   * repeat calls for the same tenant, which content-defined chunking would
   * otherwise dedupe into nothing new.
   */
  async function writeObjects(tenant: { tenantId: string; storage: StorageTargets }, seed = 0) {
    const index = new PgChunkIndex(tenantRunner(db, tenant.tenantId), tenant.tenantId);
    const writer = new ChunkWriter({
      tenantId: tenant.tenantId,
      storage: tenant.storage,
      keys: keys(tenant.tenantId),
      index,
      maxPackBytes: 2 * 1024,
    });
    const objects: ManifestObject[] = [];
    for (let i = 0; i < 12; i++) {
      const content = Buffer.from(`object ${seed}-${i} `.repeat(40 + i));
      const written = await writer.write(content);
      objects.push({
        path: `files/${seed}-${i}.txt`,
        size: written.size,
        mtime: 0,
        sha256: written.sha256,
        chunks: written.chunks,
      });
    }
    await writer.close();
    const live = objects.filter((_, i) => i % 2 === 1);
    await index.addReferences(live.flatMap((object) => object.chunks));
    return { index, live };
  }

  it("deletes no pack a running restore or verify of the tenant reads", async () => {
    const tenant = await createTenant();
    const bystander = await createTenant();
    const { index, live } = await writeObjects(tenant);
    const liveIds = live.flatMap((object) => object.chunks);
    const filesBefore = await packFiles(tenant);
    const rowsBefore = await packRows(tenant.tenantId);
    expect(rowsBefore.length).toBeGreaterThan(2);
    // Past the 72-hour cutoff for everything written above.
    let now = new Date(Date.now() + 100 * HOUR);

    // A restore and then a verify of the tenant are running: nothing moves.
    for (const queue of ["restore", "verify"] as const) {
      const running = await startJob(tenant.tenantId, queue);
      expect(await gcBlockerFor(tenantRunner(db, tenant.tenantId), tenant.tenantId)).toBe(
        `${queue}_running`,
      );
      const report = await scrubAt(tenant, now);
      expect(report.gc).toEqual({ status: "skipped", reason: `${queue}_running` });
      expect(await packFiles(tenant)).toEqual(filesBefore);
      expect(await packRows(tenant.tenantId)).toEqual(rowsBefore);
      await finishJob(tenant.tenantId, running, now);
      now = new Date(now.getTime() + HOUR);
    }

    // Another tenant's restore does not hold this tenant's collection up. A
    // restore of this tenant that looked its chunks up just before still
    // reads every object: the swapped-out packs stay for their grace period.
    const elsewhere = await startJob(bystander.tenantId, "restore");
    const reader = new ChunkReader({
      storage: tenant.storage,
      keys: keys(tenant.tenantId),
      index: await frozenIndex(index, liveIds),
    });
    const collected = await scrubAt(tenant, now);
    expect(collected.gc).toMatchObject({ status: "completed" });
    if (collected.gc.status === "completed") {
      expect(collected.gc.packsRewritten + collected.gc.packsRemoved).toBeGreaterThan(0);
    }
    const superseded = collected.superseded.pending.map((pack) => pack.path).sort();
    expect(superseded.length).toBeGreaterThan(0);
    expect(superseded.every((path) => rowsBefore.includes(path))).toBe(true);
    expect(await packFiles(tenant)).toEqual(
      [...(await packRows(tenant.tenantId)), ...superseded].sort(),
    );
    for (const object of live) {
      await reader.readObjectToBuffer(object);
    }
    const previous = await loadPreviousScrub(tenantRunner(db, tenant.tenantId), tenant.tenantId);
    expect(previous.superseded).toEqual(collected.superseded.pending);
    await finishJob(bystander.tenantId, elsewhere, now);

    // A day later a verify of the tenant is running: the files stay.
    now = new Date(now.getTime() + 25 * HOUR);
    const verifying = await startJob(tenant.tenantId, "verify");
    const busy = await scrubAt(tenant, now, "sample");
    expect(busy.superseded).toEqual({
      released: 0,
      releasedBytes: 0,
      pending: collected.superseded.pending,
    });
    expect((await packFiles(tenant)).filter((path) => superseded.includes(path))).toEqual(
      superseded,
    );
    for (const object of live) {
      await reader.readObjectToBuffer(object);
    }
    await finishJob(tenant.tenantId, verifying, now);

    // Once nothing runs, the next scrub deletes them; every live object still
    // reads back through the catalog.
    now = new Date(now.getTime() + HOUR);
    const released = await scrubAt(tenant, now, "sample");
    expect(released.superseded).toMatchObject({ released: superseded.length, pending: [] });
    expect(await packFiles(tenant)).toEqual(await packRows(tenant.tenantId));
    const current = new ChunkReader({
      storage: tenant.storage,
      keys: keys(tenant.tenantId),
      index,
    });
    for (const object of live) {
      await current.readObjectToBuffer(object);
    }
  });

  it("disables collection entirely while a storage migration is active, and resumes once it finishes", async () => {
    const tenant = await createTenant();
    await writeObjects(tenant);
    const rowsBefore = await packRows(tenant.tenantId);
    const now = new Date(Date.now() + 200 * HOUR); // well past the GC cutoff

    const [destination] = await db
      .insert(storageTargets)
      .values({
        tenantId: tenant.tenantId,
        kind: "local",
        role: "copy",
        config: { basePath: "/mnt/dest" },
      })
      .returning();
    const [migration] = await db
      .insert(storageMigrations)
      .values({
        tenantId: tenant.tenantId,
        sourceTargetId: null,
        destinationTargetId: destination?.id as string,
        mode: "move",
        status: "copying",
      })
      .returning();

    const duringMigration = await scrubAt(tenant, now);
    expect(duringMigration.gc).toEqual({ status: "skipped", reason: "disabled" });
    expect(await packRows(tenant.tenantId)).toEqual(rowsBefore);

    await db
      .update(storageMigrations)
      .set({ status: "completed", finishedAt: now })
      .where(eq(storageMigrations.id, migration?.id as string));

    const afterMigration = await scrubAt(tenant, new Date(now.getTime() + HOUR));
    expect(afterMigration.gc.status).toBe("completed");
  });

  it("gcBlockerFor reports a blocker while a storage migration is unfinished, whatever jobs.status says", async () => {
    const tenant = await createTenant();
    const run = tenantRunner(db, tenant.tenantId);
    expect(await gcBlockerFor(run, tenant.tenantId)).toBeNull();

    const [destination] = await db
      .insert(storageTargets)
      .values({
        tenantId: tenant.tenantId,
        kind: "local",
        role: "copy",
        config: { basePath: "/mnt/dest" },
      })
      .returning();
    const [migration] = await db
      .insert(storageMigrations)
      .values({
        tenantId: tenant.tenantId,
        sourceTargetId: null,
        destinationTargetId: destination?.id as string,
        mode: "move",
        status: "verifying",
      })
      .returning();
    // No `jobs` row at all for this migration (it may not have one yet, or
    // the worker between attempts): the blocker still comes from
    // `storage_migrations` itself, not from a running job.
    expect(await gcBlockerFor(run, tenant.tenantId)).toBe("backup_running");

    await db
      .update(storageMigrations)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(storageMigrations.id, migration?.id as string));
    expect(await gcBlockerFor(run, tenant.tenantId)).toBeNull();
  });

  it("stops re-packing once a migration starts mid-run, instead of only checking at the start", async () => {
    const tenant = await createTenant();
    // Several independent batches of packs, so the re-pack loop (one
    // `blockedBy` check and one Postgres+filesystem round trip per candidate
    // pack) has many iterations to be caught partway through, rather than
    // finishing before the concurrently-inserted migration below lands.
    for (let batch = 0; batch < 6; batch++) {
      await writeObjects(tenant, batch);
    }
    const now = new Date(Date.now() + 200 * HOUR); // well past the GC cutoff

    // Nothing is active yet: the scrub is free to start collecting. A
    // migration is inserted a moment after the run starts (the API creating
    // a "move" target, say), simulating one that begins while this scrub's
    // re-pack loop is already under way (file doc comment on
    // `gcBlockerFor`: it is asked again between every two packs).
    const insertMigrationSoon = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const [destination] = await db
        .insert(storageTargets)
        .values({
          tenantId: tenant.tenantId,
          kind: "local",
          role: "copy",
          config: { basePath: "/mnt/dest-midrun" },
        })
        .returning();
      await db.insert(storageMigrations).values({
        tenantId: tenant.tenantId,
        sourceTargetId: null,
        destinationTargetId: destination?.id as string,
        mode: "move",
        status: "copying",
      });
    })();

    const [report] = await Promise.all([scrubAt(tenant, now), insertMigrationSoon]);

    // Whenever the insert landed, the migration was never ignored: caught
    // before the run even started collecting ("disabled", the top-level
    // gate), caught by the very first dynamic check inside `runGc` before any
    // pack was touched ("backup_running"), or caught partway through the
    // re-pack loop after some packs were already examined (`interruptedBy`).
    // Never a plain "completed" run with nothing having noticed it.
    if (report.gc.status === "completed") {
      expect(report.gc.interruptedBy).toBe("backup_running");
    } else {
      expect(["disabled", "backup_running"]).toContain(report.gc.reason);
    }
  }, 20_000);

  it("does not mark packs damaged that a finished 'keep' replacement left on the retired target", async () => {
    const tenant = await createTenant();
    const switchedAt = new Date("2026-06-01T00:00:00.000Z");

    // A pack from before the "keep" switch: no file on the current primary at
    // all (it lives only on the retired `previous` target, which this test
    // does not need to set up), and never referenced by the current backend.
    const legacyPath = packKey(tenant.tenantId, randomUUID());
    await db.insert(packs).values({
      tenantId: tenant.tenantId,
      path: legacyPath,
      sha256: "a".repeat(64),
      size: 123,
      createdAt: new Date(switchedAt.getTime() - HOUR),
    });

    const destination = await db
      .insert(storageTargets)
      .values({
        tenantId: tenant.tenantId,
        kind: "local",
        role: "primary",
        config: { basePath: join(root, tenant.tenantId) },
      })
      .returning();
    await db.insert(storageMigrations).values({
      tenantId: tenant.tenantId,
      sourceTargetId: null,
      destinationTargetId: destination[0]?.id as string,
      mode: "keep",
      status: "completed",
      switchedAt,
      finishedAt: switchedAt,
    });

    expect(await loadKeepCutover(tenantRunner(db, tenant.tenantId), tenant.tenantId)).toEqual(
      switchedAt,
    );

    // A pack written after the switch: real, on the current primary.
    await writeObjects(tenant);
    const currentPackCountBefore = (await packRows(tenant.tenantId)).length - 1;

    const now = new Date(switchedAt.getTime() + 200 * HOUR);
    const report = await scrubAt(tenant, now, "full");

    // Only the post-switch packs were even looked at; the legacy one (absent
    // from the primary) was neither checked nor reported corrupt.
    expect(report.packsTotal).toBe(currentPackCountBefore);
    expect(report.corrupt).toEqual([]);

    const [legacyRow] = await db.select().from(packs).where(eq(packs.path, legacyPath));
    expect(legacyRow?.damagedAt).toBeNull();
  });
});
