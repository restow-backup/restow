/**
 * Postgres-backed framework tests: the real chunk/snapshot/cursor/progress
 * seams, the job lifecycle and resume-on-restart against a scratch database.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_test` is dropped and recreated there on every run, then
 * migrated). Without it the suite is skipped and says so; docs/TESTING.md lists
 * this under the integration stage.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChunkReader,
  ChunkWriter,
  type Dek,
  JobAbortedError,
  Keyring,
  LocalStorageBackend,
  SnapshotWriter,
  type StorageTargets,
  createLogger,
  encryptChunk,
  generateDek,
  noopLogger,
  partialManifestKey,
  wrapDek,
} from "@restow/core";
import {
  type Database,
  chunks as chunkRows,
  createDb,
  itemFailures,
  jobProgress,
  jobs,
  manifestObjects,
  packs,
  protectedObjects,
  providers,
  secrets,
  snapshots,
  sources,
  storageMigrations,
  storageTargets,
  tenantKeys,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AnyJobHandler,
  type JobHandler,
  PgChunkIndex,
  PgCursorStore,
  PgSecretReader,
  PgSnapshotIndex,
  TenantCache,
  TenantConcurrencyLimiter,
  type WorkerJobContext,
  type WorkerRuntime,
  abandonedCheckpointProbe,
  discardAbandonedSnapshots,
  loadTenantKeyring,
  mirrorTenantKeys,
  resolveTenantStorage,
  runJob,
  secretAad,
  tenantRunner,
} from "./handlers/framework.js";
import { PgPackCatalog } from "./handlers/scrub.js";
import { PgProgressSink } from "./progress.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_test";

function testDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = testDatabaseUrl(base);
  await runMigrations(url);
  return url;
}

const dek: Dek = generateDek(1);
const kek = Buffer.alloc(32, 0x5a);

interface Fixture {
  tenantId: string;
  sourceId: string;
  protectedObjectId: string;
}

async function createFixture(db: Database): Promise<Fixture> {
  const [provider] = await db.insert(providers).values({ name: "test provider" }).returning();
  const [tenant] = await db
    .insert(tenants)
    .values({ providerId: provider.id, name: "Tenant", slug: `t-${randomUUID().slice(0, 8)}` })
    .returning();
  await db.insert(tenantKeys).values({
    tenantId: tenant.id,
    keyVersion: 1,
    encryptedDek: wrapDek(kek, dek).toString("base64"),
    kekId: "env:test",
  });
  const [source] = await db
    .insert(sources)
    .values({ tenantId: tenant.id, kind: "m365", name: "M365", config: {} })
    .returning();
  const [object] = await db
    .insert(protectedObjects)
    .values({
      tenantId: tenant.id,
      sourceId: source.id,
      kind: "mailbox",
      externalId: "alice@example.test",
      displayName: "Alice",
    })
    .returning();
  return { tenantId: tenant.id, sourceId: source.id, protectedObjectId: object.id };
}

function pgBossJob(data: unknown, retryCount = 0, retryLimit = 3) {
  return {
    id: randomUUID(),
    name: "backup",
    data,
    expireInSeconds: 3600,
    priority: 0,
    state: "active" as const,
    retryLimit,
    retryCount,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: new Date(),
    startedOn: new Date(),
    singletonKey: null,
    singletonOn: null,
    expireIn: { toPostgres: () => "", toISO: () => "", toISOString: () => "" },
    createdOn: new Date(),
    completedOn: null,
    keepUntil: new Date(),
    deadLetter: "",
    policy: "stately" as const,
    output: {},
  };
}

describe.skipIf(!adminUrl)("framework against Postgres", () => {
  let db: Database;
  let root: string;
  let storage: StorageTargets;
  let fixture: Fixture;
  let keys: Keyring;

  beforeAll(async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    db = createDb(url);
    root = await mkdtemp(join(tmpdir(), "restow-worker-"));
    storage = {
      primary: new LocalStorageBackend(join(root, "primary")),
      copies: [new LocalStorageBackend(join(root, "copy"))],
    };
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    fixture = await createFixture(db);
    keys = new Keyring(fixture.tenantId, [dek]);
  });

  function runtime(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
    return {
      db,
      defaultStorage: storage,
      keyrings: new TenantCache(async () => keys),
      storage: new TenantCache(async () => storage),
      logger: noopLogger,
      tenantLimiter: new TenantConcurrencyLimiter(2),
      shutdownSignal: new AbortController().signal,
      now: () => new Date(),
      cancelPollMs: 50,
      progress: { flushEveryItems: 1, flushIntervalMs: 0 },
      ...overrides,
    };
  }

  async function jobRow(jobId: string) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    return row;
  }

  it("loads the keyring from tenant_keys and mirrors wrapped keys to every target", async () => {
    const { EnvKeyProvider } = await import("@restow/core");
    const loaded = await loadTenantKeyring({
      db,
      tenantId: fixture.tenantId,
      keyProvider: new EnvKeyProvider(kek),
    });
    expect(loaded.current.material.equals(dek.material)).toBe(true);
    const run = tenantRunner(db, fixture.tenantId);
    await mirrorTenantKeys({ run, tenantId: fixture.tenantId, storage, logger: noopLogger });
    const key = `tenants/${fixture.tenantId}/keys/1`;
    expect(await storage.primary.head(key)).not.toBeNull();
    expect(await storage.copies[0].head(key)).not.toBeNull();
    const wrapped = await storage.primary.get(key);

    // A truncated or damaged mirror is rewritten, not taken for present.
    await storage.primary.put(key, wrapped.subarray(0, 7));
    const flipped = Buffer.from(wrapped);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
    await storage.copies[0].put(key, flipped);
    await mirrorTenantKeys({ run, tenantId: fixture.tenantId, storage, logger: noopLogger });
    expect((await storage.primary.get(key)).equals(wrapped)).toBe(true);
    expect((await storage.copies[0].get(key)).equals(wrapped)).toBe(true);
    await expect(
      loadTenantKeyring({ db, tenantId: randomUUID(), keyProvider: new EnvKeyProvider(kek) }),
    ).rejects.toThrow(/no data-encryption key/);
  });

  it("round-trips objects through the pack store with the Postgres chunk index", async () => {
    const run = tenantRunner(db, fixture.tenantId);
    const index = new PgChunkIndex(run, fixture.tenantId);
    const writer = new ChunkWriter({ tenantId: fixture.tenantId, storage, keys, index });
    const data = Buffer.from("hello from the worker integration test".repeat(100));
    const first = await writer.write(data);
    await writer.close();

    const packRows = await db.select().from(packs).where(eq(packs.tenantId, fixture.tenantId));
    expect(packRows).toHaveLength(1);
    const chunkRowsFound = await db
      .select()
      .from(chunkRows)
      .where(eq(chunkRows.tenantId, fixture.tenantId));
    expect(chunkRowsFound).toHaveLength(first.chunks.length);
    expect(chunkRowsFound[0].refcount).toBe(0);

    // A second writer sees the chunk through the index and stores nothing new.
    const again = new ChunkWriter({ tenantId: fixture.tenantId, storage, keys, index });
    const second = await again.write(data);
    expect(second.newChunks).toBe(0);
    expect((await again.close()).packsWritten).toBe(0);

    await index.addReferences([...first.chunks, ...first.chunks]);
    const located = await index.locate(first.chunks);
    expect(located.get(first.chunks[0])?.packPath).toBe(packRows[0].path);
    const [row] = await db.select().from(chunkRows).where(eq(chunkRows.tenantId, fixture.tenantId));
    expect(row.refcount).toBe(2);
    await index.releaseReferences(first.chunks);
    await index.releaseReferences(first.chunks);
    await index.releaseReferences(first.chunks); // never below zero
    const [after] = await db
      .select()
      .from(chunkRows)
      .where(eq(chunkRows.tenantId, fixture.tenantId));
    expect(after.refcount).toBe(0);

    const reader = new ChunkReader({ storage, keys, index });
    expect(
      (
        await reader.readObjectToBuffer({
          path: "x",
          size: data.length,
          mtime: 0,
          chunks: first.chunks,
        })
      ).equals(data),
    ).toBe(true);
  });

  it("stops deduplicating against a damaged pack, moves its chunks to the intact copy and retires it", async () => {
    const run = tenantRunner(db, fixture.tenantId);
    const index = new PgChunkIndex(run, fixture.tenantId);
    const catalog = new PgPackCatalog(run, fixture.tenantId);
    const data = Buffer.from("content that outlives its pack ".repeat(200));
    const writer = new ChunkWriter({ tenantId: fixture.tenantId, storage, keys, index });
    const first = await writer.write(data);
    await writer.close();
    await index.addReferences(first.chunks);
    const [damaged] = await catalog.listPacks();
    if (!damaged) {
      throw new Error("expected a pack");
    }
    expect(damaged.damagedAt).toBeNull();

    const markedAt = new Date("2026-09-20T02:00:00.000Z");
    await catalog.setDamaged([damaged.id], markedAt);
    await catalog.setDamaged([damaged.id], new Date("2026-09-21T02:00:00.000Z"));
    expect((await catalog.listPacks())[0]?.damagedAt).toEqual(markedAt);
    expect(await index.existing(first.chunks)).toEqual(new Set());
    expect(await catalog.retireDamagedPack(damaged)).toBe(false);

    const again = new ChunkWriter({ tenantId: fixture.tenantId, storage, keys, index });
    const second = await again.write(data);
    await again.close();
    expect(second.newChunks).toBe(new Set(first.chunks).size);
    const rows = await db.select().from(chunkRows).where(eq(chunkRows.tenantId, fixture.tenantId));
    expect(rows).toHaveLength(new Set(first.chunks).size);
    expect(rows.every((row) => row.packId !== damaged.id && row.refcount === 1)).toBe(true);
    expect(await catalog.chunksOf(damaged.id)).toEqual([]);

    // The damaged file is no longer needed: the data reads from the intact copy.
    await storage.primary.delete(damaged.path);
    await storage.copies[0]?.delete(damaged.path);
    const reader = new ChunkReader({ storage, keys, index });
    expect(
      (
        await reader.readObjectToBuffer({
          path: "x",
          size: data.length,
          mtime: 0,
          chunks: first.chunks,
        })
      ).equals(data),
    ).toBe(true);
    expect(await catalog.retireDamagedPack(damaged)).toBe(true);
    expect((await catalog.listPacks()).map((pack) => pack.id)).not.toContain(damaged.id);

    // A later intact copy of an intact chunk keeps the first row.
    const [kept] = await catalog.listPacks();
    const third = new ChunkWriter({ tenantId: fixture.tenantId, storage, keys, index });
    expect((await third.write(data)).newChunks).toBe(0);
    await third.close();
    expect((await catalog.chunksOf(kept?.id as string)).length).toBe(new Set(first.chunks).size);
  });

  it("commits snapshots with a manifest_objects mirror, resumes from a checkpointed cursor", async () => {
    const run = tenantRunner(db, fixture.tenantId);
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId: fixture.tenantId,
      queue: "backup",
      protectedObjectId: fixture.protectedObjectId,
    });
    const protectedObject = {
      id: fixture.protectedObjectId,
      tenantId: fixture.tenantId,
      sourceId: fixture.sourceId,
      kind: "mailbox" as const,
      externalId: "alice@example.test",
      displayName: "Alice",
      userId: null,
    };
    const makeContext = (): WorkerJobContext => ({
      jobId,
      tenantId: fixture.tenantId,
      queue: "backup",
      attempt: 0,
      db,
      storage,
      keys,
      secrets: new PgSecretReader(run, fixture.tenantId, keys),
      chunkIndex: new PgChunkIndex(run, fixture.tenantId),
      snapshots: new PgSnapshotIndex(run, fixture.tenantId, noopLogger),
      progress: {
        total() {},
        advance() {},
        fail() {},
        phase() {},
        snapshot: () => ({ total: 0, done: 0, failed: 0, bytes: 0, phase: null, etaSeconds: null }),
        flush: async () => {},
      },
      cursor: new PgCursorStore(run, jobId),
      logger: noopLogger,
      signal: new AbortController().signal,
      now: () => new Date(),
      protectedObject,
    });

    const first = await SnapshotWriter.begin(makeContext(), {
      protectedObject,
      sourceType: "m365",
    });
    const mail = await first.chunks.write(Buffer.from("Subject: one\r\n\r\nfirst"));
    first.add({
      path: "Inbox/one.eml",
      id: "m1",
      type: "message",
      size: mail.size,
      mtime: Date.now(),
      chunks: mail.chunks,
      metadata: { messageId: "<one@x>" },
    });
    await first.checkpoint({ folderId: "inbox", lastItemId: "m1" });

    // "Restart": a fresh context loads the cursor and resumes the same snapshot.
    const resumedCtx = makeContext();
    const cursor = await resumedCtx.cursor.load();
    expect(cursor?.folderId).toBe("inbox");
    expect(cursor?.snapshot?.snapshotId).toBe(first.snapshotId);
    const resumed = await SnapshotWriter.begin(resumedCtx, {
      protectedObject,
      sourceType: "m365",
      checkpoint: cursor?.snapshot,
    });
    expect(resumed.snapshotId).toBe(first.snapshotId);
    expect(resumed.objectCount).toBe(1);
    resumed.add({ path: "Inbox", type: "folder", size: 0, mtime: 0, chunks: [] });
    const committed = await resumed.commit();

    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, committed.snapshotId));
    expect(row.manifestPath).toBe(committed.manifestPath);
    expect(row.itemCount).toBe(2);
    expect(row.sequence).toBe(1);
    const mirrored = await db
      .select()
      .from(manifestObjects)
      .where(eq(manifestObjects.snapshotId, committed.snapshotId));
    expect(mirrored.map((m) => [m.kind, m.path, m.parentPath, m.messageId]).sort()).toEqual([
      ["folder", "Inbox", "", null],
      ["mail", "Inbox/one.eml", "Inbox", "<one@x>"],
    ]);
    expect(await resumedCtx.snapshots.latestCompleted(fixture.protectedObjectId)).toMatchObject({
      id: committed.snapshotId,
    });
    expect(await resumedCtx.snapshots.nextSequence(fixture.protectedObjectId)).toBe(2);

    // Discard only touches in-progress rows.
    await resumedCtx.snapshots.discard(committed.snapshotId);
    expect(await resumedCtx.snapshots.get(committed.snapshotId)).not.toBeNull();
  });

  it("persists progress and item failures with attempts carried across runs", async () => {
    const run = tenantRunner(db, fixture.tenantId);
    const makeJob = async () => {
      const id = randomUUID();
      await db.insert(jobs).values({
        id,
        tenantId: fixture.tenantId,
        queue: "backup",
        protectedObjectId: fixture.protectedObjectId,
      });
      return id;
    };
    const firstJob = await makeJob();
    let cancelSeen = 0;
    const sink = new PgProgressSink({
      run,
      tenantId: fixture.tenantId,
      jobId: firstJob,
      protectedObjectId: fixture.protectedObjectId,
      logger: noopLogger,
      onCancelRequested: () => cancelSeen++,
    });
    await sink.ensureRow();
    await sink.publish({
      snapshot: { total: 10, done: 3, failed: 1, bytes: 512, phase: "download", etaSeconds: 7 },
      failures: [{ itemRef: "item-1", reason: "410 Gone" }],
    });
    const [progress] = await db.select().from(jobProgress).where(eq(jobProgress.jobId, firstJob));
    expect(progress).toMatchObject({ total: 10, done: 3, failed: 1, bytes: 512, etaSeconds: 7 });

    const secondJob = await makeJob();
    const secondSink = new PgProgressSink({
      run,
      tenantId: fixture.tenantId,
      jobId: secondJob,
      protectedObjectId: fixture.protectedObjectId,
      logger: noopLogger,
    });
    await secondSink.publish({
      snapshot: { total: 1, done: 0, failed: 1, bytes: 0, phase: null, etaSeconds: null },
      failures: [
        { itemRef: "item-1", reason: "410 Gone again" },
        { itemRef: "item-2", reason: "timeout" },
      ],
    });
    const failures = await db.select().from(itemFailures).where(eq(itemFailures.jobId, secondJob));
    expect(failures.map((f) => [f.itemRef, f.attempts]).sort()).toEqual([
      ["item-1", 2],
      ["item-2", 1],
    ]);

    // Cancellation is detected on the next publish.
    await db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, firstJob));
    await sink.publish({
      snapshot: { total: 10, done: 4, failed: 1, bytes: 600, phase: null, etaSeconds: null },
      failures: [],
    });
    await sink.publish({
      snapshot: { total: 10, done: 5, failed: 1, bytes: 700, phase: null, etaSeconds: null },
      failures: [],
    });
    expect(cancelSeen).toBe(1);
  });

  it("opens API-sealed secrets and resolves tenant storage targets", async () => {
    const run = tenantRunner(db, fixture.tenantId);
    const secretId = randomUUID();
    await db.insert(secrets).values({
      id: secretId,
      tenantId: fixture.tenantId,
      kind: "s3_credentials",
      ciphertext: encryptChunk(
        dek,
        Buffer.from('{"accessKeyId":"AK","secretAccessKey":"SK"}'),
        secretAad(secretId),
      ).toString("base64"),
      keyVersion: 1,
    });
    const reader = new PgSecretReader(run, fixture.tenantId, keys);
    expect(await reader.get(secretId)).toContain('"accessKeyId":"AK"');
    expect(await reader.get(randomUUID())).toBeNull();

    const bound = randomUUID();
    await db.insert(secrets).values({
      id: bound,
      tenantId: fixture.tenantId,
      kind: "imap_password",
      ciphertext: encryptChunk(dek, Buffer.from("x"), secretAad(secretId)).toString("base64"),
    });
    await expect(reader.get(bound)).rejects.toThrow(/different secret id/);

    // No storage_targets rows: installation defaults apply, with no `previous` targets.
    const defaults = await resolveTenantStorage({
      run,
      tenantId: fixture.tenantId,
      secretReader: reader,
      defaults: storage,
      logger: noopLogger,
    });
    expect(defaults).toEqual({ ...storage, previous: [], keepGeneration: null });

    await db.insert(storageTargets).values([
      {
        tenantId: fixture.tenantId,
        kind: "local",
        role: "primary",
        config: { basePath: join(root, "tenant-primary") },
      },
      {
        tenantId: fixture.tenantId,
        kind: "local",
        role: "copy",
        config: { basePath: join(root, "tenant-copy") },
      },
      {
        tenantId: fixture.tenantId,
        kind: "s3",
        role: "copy",
        config: { bucket: "b", endpoint: "http://127.0.0.1:1" },
        secretRef: secretId,
      },
      {
        tenantId: fixture.tenantId,
        kind: "local",
        role: "previous",
        config: { basePath: join(root, "tenant-retired") },
      },
      // A "keep" switch away from the installation default: no addressing of
      // its own, opens to `defaults.primary` (docs/STORAGE.md).
      {
        tenantId: fixture.tenantId,
        kind: "installation_default",
        role: "previous",
        config: {},
      },
    ]);
    const resolved = await resolveTenantStorage({
      run,
      tenantId: fixture.tenantId,
      secretReader: reader,
      defaults: storage,
      logger: noopLogger,
    });
    expect(resolved.primary).toBeInstanceOf(LocalStorageBackend);
    expect(resolved.copies).toHaveLength(2);
    await resolved.primary.put("probe", Buffer.from("ok"));
    expect(await new LocalStorageBackend(join(root, "tenant-primary")).get("probe")).toEqual(
      Buffer.from("ok"),
    );

    // Both `previous` rows resolved: the retired local target, in creation
    // order, and the installation-default placeholder as `storage.primary` itself.
    expect(resolved.previous).toHaveLength(2);
    expect(resolved.previous[0]).toBeInstanceOf(LocalStorageBackend);
    await resolved.previous[0].put("retired-probe", Buffer.from("retired"));
    expect(
      await new LocalStorageBackend(join(root, "tenant-retired")).get("retired-probe"),
    ).toEqual(Buffer.from("retired"));
    expect(resolved.previous[1]).toBe(storage.primary);
  });

  it("stamps keepGeneration from the tenant's latest 'keep' switch, read atomically with the storage_targets rows", async () => {
    const run = tenantRunner(db, fixture.tenantId);
    const reader = new PgSecretReader(run, fixture.tenantId, keys);

    const [primaryRow] = await db
      .insert(storageTargets)
      .values({
        tenantId: fixture.tenantId,
        kind: "local",
        role: "primary",
        config: { basePath: join(root, "keep-generation-primary") },
      })
      .returning();
    const [previousRow] = await db
      .insert(storageTargets)
      .values({
        tenantId: fixture.tenantId,
        kind: "local",
        role: "previous",
        config: { basePath: join(root, "keep-generation-previous") },
      })
      .returning();
    if (!primaryRow || !previousRow) {
      throw new Error("insert did not return the row");
    }

    const beforeSwitch = await resolveTenantStorage({
      run,
      tenantId: fixture.tenantId,
      secretReader: reader,
      defaults: storage,
      logger: noopLogger,
    });
    expect(beforeSwitch.keepGeneration).toBeNull();

    const switchedAt = new Date();
    await db.insert(storageMigrations).values({
      tenantId: fixture.tenantId,
      sourceTargetId: previousRow.id,
      destinationTargetId: primaryRow.id,
      mode: "keep",
      status: "completed",
      switchedAt,
    });

    const afterSwitch = await resolveTenantStorage({
      run,
      tenantId: fixture.tenantId,
      secretReader: reader,
      defaults: storage,
      logger: noopLogger,
    });
    expect(afterSwitch.keepGeneration?.getTime()).toBe(switchedAt.getTime());
  });

  describe("runJob lifecycle", () => {
    const handlerFor = (run: JobHandler<"backup">["run"]): AnyJobHandler => ({
      queue: "backup",
      run,
    });

    it("marks a successful job completed and clears its cursor", async () => {
      const jobId = randomUUID();
      const payload = {
        jobId,
        tenantId: fixture.tenantId,
        protectedObjectId: fixture.protectedObjectId,
      };
      let seen: WorkerJobContext | undefined;
      const handler = handlerFor(async (ctx) => {
        seen = ctx;
        await ctx.cursor.save({ folderId: "inbox" });
        ctx.progress.total(2);
        ctx.progress.advance(2, 100);
        return { summary: { objects: 2 } };
      });
      await runJob(runtime(), handler, pgBossJob(payload));
      const row = await jobRow(jobId);
      expect(row.status).toBe("completed");
      expect(row.cursor).toBeNull();
      expect(row.completedAt).not.toBeNull();
      expect(row.startedAt).not.toBeNull();
      expect(row.payload).toEqual(payload);
      expect(seen?.protectedObject?.externalId).toBe("alice@example.test");
      const [progress] = await db.select().from(jobProgress).where(eq(jobProgress.jobId, jobId));
      expect(progress).toMatchObject({ total: 2, done: 2, bytes: 100 });
    });

    it("keeps the cursor and queues a retry when the handler fails with budget left", async () => {
      const jobId = randomUUID();
      const payload = { jobId, tenantId: fixture.tenantId };
      const handler = handlerFor(async (ctx) => {
        await ctx.cursor.save({ page: 3 });
        throw new Error("Graph said no");
      });
      await expect(runJob(runtime(), handler, pgBossJob(payload, 1, 3))).rejects.toThrow(
        "Graph said no",
      );
      const row = await jobRow(jobId);
      expect(row.status).toBe("queued");
      expect(row.cursor).toEqual({ page: 3 });
      expect(row.errorMessage).toContain("Graph said no");

      // The retry resumes from the cursor; out of budget it ends as failed.
      let resumedFrom: unknown = null;
      const retry = handlerFor(async (ctx) => {
        resumedFrom = await ctx.cursor.load();
        throw new Error("still failing");
      });
      await expect(runJob(runtime(), retry, pgBossJob(payload, 3, 3))).rejects.toThrow(
        "still failing",
      );
      expect(resumedFrom).toEqual({ page: 3 });
      const failed = await jobRow(jobId);
      expect(failed.status).toBe("failed");
      expect(failed.cursor).toBeNull();
    });

    it("keeps a checkpoint while a retry may resume it and discards it once the job failed for good", async () => {
      const jobId = randomUUID();
      const payload = {
        jobId,
        tenantId: fixture.tenantId,
        protectedObjectId: fixture.protectedObjectId,
      };
      let snapshotId = "";
      const handler = handlerFor(async (ctx) => {
        const writer = await SnapshotWriter.begin(ctx, {
          protectedObject: ctx.protectedObject as NonNullable<typeof ctx.protectedObject>,
          sourceType: "m365",
          checkpoint: (await ctx.cursor.load())?.snapshot,
        });
        snapshotId = writer.snapshotId;
        const item = await writer.chunks.write(Buffer.from(`item of attempt ${ctx.attempt}`));
        writer.add({ path: `mail/${ctx.attempt}`, size: item.size, mtime: 0, chunks: item.chunks });
        await writer.checkpoint();
        throw new Error("Graph said no");
      });
      const run = tenantRunner(db, fixture.tenantId);
      const probe = abandonedCheckpointProbe(run, fixture.tenantId);
      const partialKey = () => partialManifestKey(fixture.tenantId, snapshotId);
      const onTargets = async () =>
        Promise.all(
          [storage.primary, ...storage.copies].map(
            async (target) => (await target.head(partialKey())) !== null,
          ),
        );

      await expect(runJob(runtime(), handler, pgBossJob(payload, 0, 1))).rejects.toThrow();
      expect((await jobRow(jobId)).status).toBe("queued");
      expect(await onTargets()).toEqual([true, true]);
      expect(await probe(snapshotId)).toBe(false);
      const first = snapshotId;

      // The last attempt resumes the same snapshot, fails again and ends the job.
      await expect(runJob(runtime(), handler, pgBossJob(payload, 1, 1))).rejects.toThrow();
      expect(snapshotId).toBe(first);
      expect((await jobRow(jobId)).status).toBe("failed");
      expect(await onTargets()).toEqual([false, false]);
      const [row] = await db.select().from(snapshots).where(eq(snapshots.id, snapshotId));
      expect(row).toBeUndefined();
      expect(await probe(snapshotId)).toBe(true);
    });

    it("sweeps in-progress snapshots of jobs that ended for good, and only those", async () => {
      const run = tenantRunner(db, fixture.tenantId);
      const env = { tenantId: fixture.tenantId, storage, logger: noopLogger };
      const snapshotOf = async (status: "cancelled" | "active", sequence: number) => {
        const jobId = randomUUID();
        await db.insert(jobs).values({
          id: jobId,
          tenantId: fixture.tenantId,
          queue: "backup",
          status,
          protectedObjectId: fixture.protectedObjectId,
        });
        const id = randomUUID();
        await db.insert(snapshots).values({
          id,
          tenantId: fixture.tenantId,
          protectedObjectId: fixture.protectedObjectId,
          jobId,
          sequence,
        });
        await storage.primary.put(partialManifestKey(fixture.tenantId, id), Buffer.from("x"));
        return id;
      };
      const dead = await snapshotOf("cancelled", 901);
      const running = await snapshotOf("active", 902);

      expect(await discardAbandonedSnapshots(run, env, { tenant: true })).toBe(1);
      const left = await db
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(eq(snapshots.tenantId, fixture.tenantId));
      expect(left.map((row) => row.id)).toContain(running);
      expect(left.map((row) => row.id)).not.toContain(dead);
      expect(await storage.primary.head(partialManifestKey(fixture.tenantId, dead))).toBeNull();
      expect(
        await storage.primary.head(partialManifestKey(fixture.tenantId, running)),
      ).not.toBeNull();
    });

    it("aborts and records cancelled when the API cancels a running job", async () => {
      const jobId = randomUUID();
      const payload = { jobId, tenantId: fixture.tenantId };
      const handler = handlerFor(async (ctx) => {
        await db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, jobId));
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new JobAbortedError();
      });
      await runJob(runtime(), handler, pgBossJob(payload));
      const row = await jobRow(jobId);
      expect(row.status).toBe("cancelled");
      expect(row.completedAt).not.toBeNull();
    });

    it("does not run a job that was cancelled while queued", async () => {
      const jobId = randomUUID();
      await db
        .insert(jobs)
        .values({ id: jobId, tenantId: fixture.tenantId, queue: "backup", status: "cancelled" });
      let ran = false;
      await runJob(
        runtime(),
        handlerFor(async () => {
          ran = true;
        }),
        pgBossJob({ jobId, tenantId: fixture.tenantId }),
      );
      expect(ran).toBe(false);
      expect((await jobRow(jobId)).status).toBe("cancelled");
    });

    it("interrupts a running job on shutdown and leaves it queued for retry", async () => {
      const jobId = randomUUID();
      const shutdown = new AbortController();
      const handler = handlerFor(async (ctx) => {
        await ctx.cursor.save({ lastItemId: "m7" });
        shutdown.abort("shutdown");
        if (ctx.signal.aborted) {
          throw new JobAbortedError();
        }
      });
      await expect(
        runJob(
          runtime({ shutdownSignal: shutdown.signal }),
          handler,
          pgBossJob({ jobId, tenantId: fixture.tenantId }),
        ),
      ).rejects.toBeInstanceOf(JobAbortedError);
      const row = await jobRow(jobId);
      expect(row.status).toBe("queued");
      expect(row.cursor).toEqual({ lastItemId: "m7" });
    });

    it("rejects a job whose protected object does not exist without retrying", async () => {
      const jobId = randomUUID();
      let ran = false;
      await runJob(
        runtime(),
        handlerFor(async () => {
          ran = true;
        }),
        pgBossJob({ jobId, tenantId: fixture.tenantId, protectedObjectId: randomUUID() }),
      );
      expect(ran).toBe(false);
      const row = await jobRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.errorMessage).toContain("does not exist");
    });

    it("logs without secrets", async () => {
      const lines: string[] = [];
      const logger = createLogger({
        sink: (record) => lines.push(JSON.stringify(record)),
        level: "debug",
      });
      const jobId = randomUUID();
      const handler = handlerFor(async (ctx) => {
        ctx.logger.info("token refreshed", { accessToken: "eyJ-secret", tenantId: ctx.tenantId });
      });
      await runJob(runtime({ logger }), handler, pgBossJob({ jobId, tenantId: fixture.tenantId }));
      expect(lines.some((line) => line.includes("eyJ-secret"))).toBe(false);
      expect(lines.some((line) => line.includes("[redacted]"))).toBe(true);
      expect(lines.some((line) => line.includes("job completed"))).toBe(true);
    });

    it("records a failed query by its driver error, without the SQL or its parameters", async () => {
      const lines: string[] = [];
      const logger = createLogger({
        sink: (record) => lines.push(JSON.stringify(record)),
        level: "debug",
      });
      const jobId = randomUUID();
      const handler = handlerFor(async () => {
        await db.execute(sql`SELECT * FROM missing_table WHERE owner = ${"bound-parameter-value"}`);
      });
      await expect(
        runJob(
          runtime({ logger }),
          handler,
          pgBossJob({ jobId, tenantId: fixture.tenantId }, 3, 3),
        ),
      ).rejects.toThrow();
      const row = await jobRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.errorMessage).toContain('relation "missing_table" does not exist');
      for (const text of [row.errorMessage ?? "", ...lines]) {
        expect(text).not.toContain("bound-parameter-value");
        expect(text).not.toContain("Failed query");
      }
    });
  });

  /**
   * The read-only fallback a "keep" storage-target replacement leaves behind
   * (docs/STORAGE.md, "Replace the primary"): `restore` and `verify` read an
   * object that lives only on a `previous` target, `backup` and `scrub` do
   * not, and nothing ever writes to the `previous` target regardless of
   * queue. In-memory-style backends (plain directories under `root`, no
   * database rows): this exercises `runJob`'s own queue gating
   * (`storageForQueue`), not `resolveTenantStorage`'s database loading, which
   * the test above already covers.
   */
  describe('storage fallback for a retired "keep" target, by queue', () => {
    interface Fallback {
      readonly primary: LocalStorageBackend;
      readonly previous: LocalStorageBackend;
      readonly targets: StorageTargets;
    }

    async function setUp(): Promise<Fallback> {
      const primaryPath = join(root, `fallback-primary-${randomUUID()}`);
      const previousPath = join(root, `fallback-previous-${randomUUID()}`);
      const primary = new LocalStorageBackend(primaryPath);
      const previous = new LocalStorageBackend(previousPath);
      await previous.put("retired-only", Buffer.from("from the retired target"));
      return {
        primary,
        previous,
        targets: { primary, copies: [], previous: [previous] } as StorageTargets,
      };
    }

    function payloadFor(extra: Record<string, unknown> = {}) {
      return {
        jobId: randomUUID(),
        tenantId: fixture.tenantId,
        protectedObjectId: fixture.protectedObjectId,
        ...extra,
      };
    }

    it("lets restore read an object that lives only on the previous target, and never writes there", async () => {
      const { primary, previous, targets } = await setUp();
      let read: Buffer | undefined;
      const handler: AnyJobHandler = {
        queue: "restore",
        run: async (ctx) => {
          read = await ctx.storage.primary.get("retired-only");
          // A write from this job must still only ever reach the real primary.
          await ctx.storage.primary.put("written-by-restore", Buffer.from("new"));
        },
      };
      const payload = payloadFor({ restoreJobId: randomUUID() });
      await runJob(
        runtime({ storage: new TenantCache(async () => targets) }),
        handler,
        pgBossJob(payload),
      );
      expect((await jobRow(payload.jobId)).status).toBe("completed");
      expect(read?.toString()).toBe("from the retired target");
      expect(await primary.head("written-by-restore")).not.toBeNull();
      expect(await previous.head("written-by-restore")).toBeNull();
      // The previous target still holds only what it started with.
      expect(await previous.list("")).toEqual(["retired-only"]);
    });

    it("lets verify read the same way, and never writes there either", async () => {
      const { primary, previous, targets } = await setUp();
      let read: Buffer | undefined;
      const handler: AnyJobHandler = {
        queue: "verify",
        run: async (ctx) => {
          read = await ctx.storage.primary.get("retired-only");
          await ctx.storage.primary.put("written-by-verify", Buffer.from("new"));
        },
      };
      const payload = payloadFor({ kind: "verify" });
      await runJob(
        runtime({ storage: new TenantCache(async () => targets) }),
        handler,
        pgBossJob(payload),
      );
      expect((await jobRow(payload.jobId)).status).toBe("completed");
      expect(read?.toString()).toBe("from the retired target");
      expect(await primary.head("written-by-verify")).not.toBeNull();
      expect(await previous.head("written-by-verify")).toBeNull();
    });

    it("lets backup read an object that lives only on the previous target too, and never writes there", async () => {
      // Every engine's incremental run calls SnapshotWriter.loadPreviousManifest()
      // to dedupe and carry unchanged objects forward; after a "keep" switch that
      // manifest can live only on the retired target (docs/STORAGE.md, "Replace
      // the primary", "Known limitations" is not about this: it is fixed, not a
      // gap). Without this fallback, every later backup of such an object would
      // fail permanently.
      const { primary, previous, targets } = await setUp();
      let read: Buffer | undefined;
      const handler: AnyJobHandler = {
        queue: "backup",
        run: async (ctx) => {
          read = await ctx.storage.primary.get("retired-only");
          await ctx.storage.primary.put("written-by-backup", Buffer.from("new"));
        },
      };
      const payload = payloadFor({ full: true });
      await runJob(
        runtime({ storage: new TenantCache(async () => targets) }),
        handler,
        pgBossJob(payload),
      );
      expect((await jobRow(payload.jobId)).status).toBe("completed");
      expect(read?.toString()).toBe("from the retired target");
      expect(await primary.head("written-by-backup")).not.toBeNull();
      expect(await previous.head("written-by-backup")).toBeNull();
      expect(await previous.list("")).toEqual(["retired-only"]);
    });

    it("leaves scrub reading the primary only, the same way (a stale previous target must not mask real corruption)", async () => {
      const { targets } = await setUp();
      let failed: unknown;
      const handler: AnyJobHandler = {
        queue: "scrub",
        run: async (ctx) => {
          await ctx.storage.primary.get("retired-only").catch((error: unknown) => {
            failed = error;
          });
        },
      };
      const payload = payloadFor({ mode: "full" });
      await runJob(
        runtime({ storage: new TenantCache(async () => targets) }),
        handler,
        pgBossJob(payload),
      );
      expect((await jobRow(payload.jobId)).status).toBe("completed");
      expect(failed).toBeDefined();
    });
  });
});
