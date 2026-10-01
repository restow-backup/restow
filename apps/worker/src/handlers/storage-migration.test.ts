/**
 * The `storage_migration` handler end to end, against a real Postgres
 * database and real local-filesystem targets (docs/STORAGE.md).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_storage_migration_test` is recreated there); without
 * it the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChunkReader,
  type JobContext,
  Keyring,
  LocalStorageBackend,
  type ManifestObject,
  type ProgressSnapshot,
  ProgressTracker,
  type ProtectedObjectRef,
  SnapshotWriter,
  type StorageMigrationJobPayload,
  type StorageTargets,
  generateDek,
  loadManifest,
  manifestKey,
  noopLogger,
  packKey,
  sha256,
  wrappedKeyKey,
} from "@restow/core";
import {
  type Database,
  type StorageTarget,
  auditLog,
  createDb,
  jobs,
  packs,
  protectedObjects,
  providers,
  snapshots,
  sources,
  storageMigrations,
  storageTargets,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import {
  PgChunkIndex,
  PgCursorStore,
  PgSnapshotIndex,
  type WorkerJobContext,
  tenantRunner,
} from "./framework.js";
import { hasActiveMigration, storageMigrationHandler } from "./storage-migration.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_storage_migration_test";

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

describe.skipIf(!adminUrl)("storageMigrationHandler against Postgres", () => {
  let db: Database;
  let root: string;
  const originalSettleMs = process.env.RESTOW_STORAGE_CACHE_SETTLE_MS;

  beforeAll(async () => {
    const base = adminUrl as string;
    await withAdmin(base, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await withAdmin(base, `CREATE DATABASE ${TEST_DB}`);
    const url = new URL(base);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    root = await mkdtemp(join(tmpdir(), "restow-storage-migration-"));
    // Every test's destination target is created moments before the handler
    // runs, not the production default's 5-plus minutes ago: disable the
    // wait for worker storage caches to settle (storage-migration.ts,
    // STORAGE_CACHE_SETTLE_MS) by default, and re-enable it with a small
    // value in the tests that specifically cover it.
    process.env.RESTOW_STORAGE_CACHE_SETTLE_MS = "0";
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
    if (originalSettleMs === undefined) {
      // Not `process.env.X = undefined`: Node coerces that to the string
      // "undefined" instead of removing the variable.
      Reflect.deleteProperty(process.env, "RESTOW_STORAGE_CACHE_SETTLE_MS");
    } else {
      process.env.RESTOW_STORAGE_CACHE_SETTLE_MS = originalSettleMs;
    }
  });

  afterEach(() => {
    process.env.RESTOW_STORAGE_CACHE_SETTLE_MS = "0";
  });

  async function createTenant(): Promise<string> {
    const [provider] = await db.insert(providers).values({ name: "P" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "T",
        slug: `t-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    return tenant?.id as string;
  }

  /**
   * Two packs, a manifest and a wrapped key on `backend`, with matching
   * `packs` rows for `tenantId` and a `snapshots` row for the manifest (a
   * fresh `sources`/`protected_objects` pair backs it) so it reads as a real,
   * live snapshot rather than one retention has already pruned — see
   * `isPrunedManifest` in storage-migration.ts.
   */
  async function seedSource(
    tenantId: string,
    backend: LocalStorageBackend,
  ): Promise<{ manifest: string; key: string; packIds: string[]; snapshotId: string }> {
    const contents = [
      Buffer.from("pack one content"),
      Buffer.from("pack two content, a bit longer"),
    ];
    const packIds = [randomUUID(), randomUUID()];
    for (const [i, content] of contents.entries()) {
      const path = packKey(tenantId, packIds[i] as string);
      await backend.put(path, content);
      await db.insert(packs).values({
        tenantId,
        path,
        size: content.length,
        sha256: sha256(content).toString("hex"),
      });
    }
    const snapshotId = randomUUID();
    const manifest = manifestKey(tenantId, snapshotId);
    await backend.put(manifest, Buffer.from('{"objects":[]}'));
    const key = wrappedKeyKey(tenantId, 1);
    await backend.put(key, Buffer.from("wrapped-dek-bytes"));
    await seedLiveSnapshot(tenantId, snapshotId, manifest);
    return { manifest, key, packIds, snapshotId };
  }

  /**
   * A `sources`/`protected_objects`/`snapshots` row backing a committed
   * manifest already on storage. `sourceName` only needs to be distinct
   * within one tenant (`sources_tenant_name_uq`); a fresh default lets a test
   * call this more than once for the same tenant without colliding.
   */
  async function seedLiveSnapshot(
    tenantId: string,
    snapshotId: string,
    manifestPath: string,
    sourceName = `Test source ${randomUUID().slice(0, 8)}`,
  ): Promise<void> {
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "imap", name: sourceName })
      .returning();
    const [protectedObject] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: source?.id as string,
        kind: "imap",
        externalId: `mailbox-${randomUUID()}@example.test`,
      })
      .returning();
    await db.insert(snapshots).values({
      id: snapshotId,
      tenantId,
      protectedObjectId: protectedObject?.id as string,
      sequence: 1,
      manifestPath,
      status: "active",
      startedAt: new Date(),
      completedAt: new Date(),
    });
  }

  async function addTarget(
    tenantId: string,
    role: "primary" | "copy",
    dir: string,
    createdAt?: Date,
  ): Promise<StorageTarget> {
    const [row] = await db
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role,
        config: { basePath: dir },
        ...(createdAt ? { createdAt } : {}),
      })
      .returning();
    return row as StorageTarget;
  }

  async function addMigration(
    tenantId: string,
    sourceTargetId: string | null,
    destinationTargetId: string,
  ) {
    const [row] = await db
      .insert(storageMigrations)
      .values({ tenantId, sourceTargetId, destinationTargetId, mode: "move", status: "copying" })
      .returning();
    return row as NonNullable<typeof row>;
  }

  /** A `jobs` row is required: PgCursorStore reads/writes its `cursor` column. */
  async function contextFor(tenantId: string, migrationId: string): Promise<WorkerJobContext> {
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "storage_migration",
      status: "active",
      payload: { jobId, tenantId, migrationId },
      startedAt: new Date(),
    });
    return {
      jobId,
      tenantId,
      queue: "storage_migration",
      attempt: 0,
      db,
      storage: { primary: new LocalStorageBackend(join(root, "unused")), copies: [] },
      keys: undefined as never, // unused: this handler never opens a keyring
      secrets: { get: async () => null },
      chunkIndex: undefined as never, // unused
      snapshots: undefined as never, // unused
      progress: {
        total() {},
        advance() {},
        fail() {},
        phase() {},
        snapshot: () => ({ total: 0, done: 0, failed: 0, bytes: 0, phase: null, etaSeconds: null }),
        flush: async () => {},
      },
      cursor: new PgCursorStore(tenantRunner(db, tenantId), jobId),
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      } as never,
      signal: new AbortController().signal,
      // Far enough in the future that it always clears the destination's
      // storage-cache settle window (its `createdAt` is real DB insert
      // time, i.e. whenever this test happens to run), without tying the
      // fixture to "the moment this test suite was written".
      now: () => new Date("2099-01-01T00:00:00.000Z"),
      protectedObject: null,
    };
  }

  function payloadFor(tenantId: string, migrationId: string): StorageMigrationJobPayload {
    return { jobId: randomUUID(), tenantId, migrationId };
  }

  /**
   * Like `contextFor`, but with a real `ProgressTracker` (core) instead of
   * the no-op stub, so a test can inspect every `total`/`done` pair it
   * published over the run — the ETA regression this guards against
   * (`runPass`'s `passesInThisRun`) only shows up in what the tracker itself
   * computes, not in anything `storage_migrations` or its DTO expose.
   */
  async function contextForTrackingProgress(
    tenantId: string,
    migrationId: string,
  ): Promise<{ ctx: WorkerJobContext; snapshots: ProgressSnapshot[] }> {
    const base = await contextFor(tenantId, migrationId);
    const snapshots: ProgressSnapshot[] = [];
    const tracker = new ProgressTracker({
      sink: {
        publish: async (update) => {
          snapshots.push(update.snapshot);
        },
      },
      flushEveryItems: 1,
      flushIntervalMs: 0,
    });
    return { ctx: { ...base, progress: tracker }, snapshots };
  }

  it("copies everything, verifies it by hash, and switches the primary atomically", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `source-${tenantId}`);
    const destDir = join(root, `dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    const seeded = await seedSource(tenantId, sourceBackend);
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    const ctx = await contextFor(tenantId, migration.id);
    const outcome = await storageMigrationHandler.run(ctx, payloadFor(tenantId, migration.id));
    expect(outcome?.summary).toMatchObject({ status: "completed" });

    const destBackend = new LocalStorageBackend(destDir);
    expect(await destBackend.get(seeded.manifest)).toEqual(
      await sourceBackend.get(seeded.manifest),
    );
    expect(await destBackend.get(seeded.key)).toEqual(await sourceBackend.get(seeded.key));
    for (const packId of seeded.packIds) {
      expect(await destBackend.get(packKey(tenantId, packId))).toEqual(
        await sourceBackend.get(packKey(tenantId, packId)),
      );
    }

    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.find((r) => r.id === destination.id)?.role).toBe("primary");
    expect(rows.find((r) => r.id === source.id)?.role).toBe("previous");

    const [finished] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    expect(finished).toMatchObject({ status: "completed", objectsTotal: 4, objectsDone: 4 });
    expect(finished?.switchedAt).not.toBeNull();
    expect(await hasActiveMigration(tenantRunner(db, tenantId), tenantId)).toBe(false);

    const audited = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const switched = audited.find((entry) => entry.action === "storage.migration.switched");
    expect(switched).toBeDefined();
    expect(switched?.details).toMatchObject({
      migrationId: migration.id,
      previousPrimary: source.id,
    });
  });

  /**
   * A minimal but real `JobContext` for driving `SnapshotWriter`/`ChunkReader`
   * directly against Postgres and a given storage view — the same production
   * classes the worker's backup and restore engines use
   * (`PgChunkIndex`/`PgSnapshotIndex`, `apps/worker/src/handlers/framework.ts`),
   * not a hand-rolled stand-in for them. Only `checkpoint()` (unused here)
   * touches `cursor`/`progress`, so both are trivial stubs.
   */
  function backupContextFor(
    tenantId: string,
    storage: StorageTargets,
    keys: Keyring,
  ): JobContext<Database> {
    const run = tenantRunner(db, tenantId);
    return {
      jobId: randomUUID(),
      tenantId,
      queue: "backup",
      attempt: 0,
      db,
      storage,
      keys,
      secrets: { get: async () => null },
      chunkIndex: new PgChunkIndex(run, tenantId),
      snapshots: new PgSnapshotIndex(run, tenantId, noopLogger),
      progress: {
        total() {},
        advance() {},
        fail() {},
        phase() {},
        snapshot: () => ({ total: 0, done: 0, failed: 0, bytes: 0, phase: null, etaSeconds: null }),
        flush: async () => {},
      },
      cursor: { load: async () => null, save: async () => {}, clear: async () => {} },
      logger: noopLogger,
      signal: new AbortController().signal,
      now: () => new Date("2026-09-24T10:00:00.000Z"),
    };
  }

  /** One mail, written and committed as a real snapshot through the chunk store. */
  async function writeMailSnapshot(
    ctx: JobContext<Database>,
    protectedObject: ProtectedObjectRef,
    path: string,
    content: Buffer,
  ): Promise<{ manifestPath: string }> {
    const writer = await SnapshotWriter.begin(ctx, {
      protectedObject,
      sourceType: "imap",
    });
    const written = await writer.chunks.write(content);
    writer.add({
      path,
      type: "mail",
      id: path,
      size: written.size,
      mtime: ctx.now().getTime(),
      sha256: written.sha256,
      chunks: written.chunks,
    });
    const committed = await writer.commit();
    return { manifestPath: committed.manifestPath };
  }

  /** The single object of a committed manifest, read back and decrypted from `storage` alone. */
  async function restoreMailFrom(
    tenantId: string,
    storage: StorageTargets,
    keys: Keyring,
    manifestPath: string,
  ): Promise<Buffer> {
    const manifest = await loadManifest(storage, manifestPath, keys);
    const object = manifest.objects[0] as ManifestObject;
    const reader = new ChunkReader({
      storage,
      keys,
      index: new PgChunkIndex(tenantRunner(db, tenantId), tenantId),
      logger: noopLogger,
    });
    return reader.readObjectToBuffer(object);
  }

  it("restores a snapshot from before the migration and one written after the switch, both from the new primary alone, with the old primary gone", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `e2e-source-${tenantId}`);
    const destDir = join(root, `e2e-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const destBackend = new LocalStorageBackend(destDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);

    const keys = new Keyring(tenantId, [generateDek(1)]);
    const [sourceRow] = await db
      .insert(sources)
      .values({ tenantId, kind: "imap", name: "E2E source" })
      .returning();
    const [protectedObjectRow] = await db
      .insert(protectedObjects)
      .values({
        tenantId,
        sourceId: sourceRow?.id as string,
        kind: "imap",
        externalId: `mailbox-${randomUUID()}@example.test`,
      })
      .returning();
    const protectedObject: ProtectedObjectRef = {
      id: protectedObjectRow?.id as string,
      tenantId,
      sourceId: sourceRow?.id as string,
      kind: "imap",
      externalId: protectedObjectRow?.externalId as string,
      displayName: null,
      userId: null,
    };

    // A real backup, written through the chunk store onto the original
    // primary, before the migration exists.
    const beforeContent = Buffer.from("a mail backed up before the migration");
    const before = await writeMailSnapshot(
      backupContextFor(tenantId, { primary: sourceBackend, copies: [] }, keys),
      protectedObject,
      "mail/Inbox/before.eml",
      beforeContent,
    );

    // Move everything onto the new primary and switch.
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));
    const migrationCtx = await contextFor(tenantId, migration.id);
    const outcome = await storageMigrationHandler.run(
      migrationCtx,
      payloadFor(tenantId, migration.id),
    );
    expect(outcome?.summary).toMatchObject({ status: "completed" });

    // A second, real backup, written after the switch: this one only ever
    // touches the new primary.
    const afterContent = Buffer.from("a mail backed up after the switch, on the new primary");
    const after = await writeMailSnapshot(
      backupContextFor(tenantId, { primary: destBackend, copies: [] }, keys),
      protectedObject,
      "mail/Inbox/after.eml",
      afterContent,
    );

    // The old primary is gone for good: restore must not need it any more.
    await rm(sourceDir, { recursive: true, force: true });

    const restoreView: StorageTargets = { primary: destBackend, copies: [] };
    const restoredBefore = await restoreMailFrom(tenantId, restoreView, keys, before.manifestPath);
    const restoredAfter = await restoreMailFrom(tenantId, restoreView, keys, after.manifestPath);
    expect(restoredBefore).toEqual(beforeContent);
    expect(restoredAfter).toEqual(afterContent);
  });

  it("creates a previous placeholder for the installation default when there was no primary row", async () => {
    const tenantId = await createTenant();
    const originalTarget = process.env.STORAGE_TARGET;
    const originalPath = process.env.STORAGE_LOCAL_PATH;
    const defaultDir = join(root, `default-${tenantId}`);
    process.env.STORAGE_TARGET = "local";
    process.env.STORAGE_LOCAL_PATH = defaultDir;
    try {
      const defaultBackend = new LocalStorageBackend(defaultDir);
      await seedSource(tenantId, defaultBackend);
      const destDir = join(root, `dest2-${tenantId}`);
      const destination = await addTarget(tenantId, "copy", destDir);
      const migration = await addMigration(tenantId, null, destination.id);

      const ctx = await contextFor(tenantId, migration.id);
      const outcome = await storageMigrationHandler.run(ctx, payloadFor(tenantId, migration.id));
      expect(outcome?.summary).toMatchObject({ status: "completed" });

      const rows = await db
        .select()
        .from(storageTargets)
        .where(eq(storageTargets.tenantId, tenantId));
      const placeholder = rows.find((r) => r.role === "previous");
      expect(placeholder).toMatchObject({ kind: "installation_default" });
      expect(rows.find((r) => r.id === destination.id)?.role).toBe("primary");

      const [finished] = await db
        .select()
        .from(storageMigrations)
        .where(eq(storageMigrations.id, migration.id));
      expect(finished?.sourceTargetId).toBe(placeholder?.id);
    } finally {
      process.env.STORAGE_TARGET = originalTarget;
      process.env.STORAGE_LOCAL_PATH = originalPath;
    }
  });

  it("does not fail over a manifest retention already pruned before the migration started", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `pruned-source-${tenantId}`);
    const destDir = join(root, `pruned-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    const seeded = await seedSource(tenantId, sourceBackend);

    // A snapshot retention pruned: its manifest file is still on the source
    // (the file delete and this migration's read raced, or simply had not
    // happened yet), but its `snapshots` row is already gone.
    const prunedSnapshotId = randomUUID();
    const prunedManifest = manifestKey(tenantId, prunedSnapshotId);
    await sourceBackend.put(prunedManifest, Buffer.from('{"objects":["pruned"]}'));

    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    const ctx = await contextFor(tenantId, migration.id);
    const outcome = await storageMigrationHandler.run(ctx, payloadFor(tenantId, migration.id));
    expect(outcome?.summary).toMatchObject({ status: "completed" });

    // Only the live manifest, the wrapped key and the two packs were moved;
    // the pruned one was never even attempted.
    const [finished] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    expect(finished).toMatchObject({ status: "completed", objectsTotal: 4, objectsDone: 4 });

    const destBackend = new LocalStorageBackend(destDir);
    expect(await destBackend.get(seeded.manifest)).toEqual(
      await sourceBackend.get(seeded.manifest),
    );
    expect(await destBackend.head(prunedManifest)).toBeNull();
  });

  it("keeps the progress tracker's total consistent across copying and verifying, so the ETA does not collapse to zero", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `progress-source-${tenantId}`);
    const destDir = join(root, `progress-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    await seedSource(tenantId, sourceBackend); // 2 packs + a manifest + a wrapped key = 4 items
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    const { ctx, snapshots } = await contextForTrackingProgress(tenantId, migration.id);
    const outcome = await storageMigrationHandler.run(ctx, payloadFor(tenantId, migration.id));
    await ctx.progress.flush();
    expect(outcome?.summary).toMatchObject({ status: "completed" });

    const copyingSnapshots = snapshots.filter((s) => s.phase === "copying");
    const verifyingSnapshots = snapshots.filter((s) => s.phase === "verifying");
    expect(copyingSnapshots.length).toBeGreaterThan(0);
    expect(verifyingSnapshots.length).toBeGreaterThan(0);

    // The bug this guards against: `total` was sized for one pass while
    // `done` kept accumulating across both, so it could run past `total`
    // (clamping "remaining" to 0, and the ETA with it) partway through
    // verifying.
    for (const snapshot of snapshots) {
      expect(snapshot.done).toBeLessThanOrEqual(snapshot.total);
    }

    // The moment verifying starts, `done` (4, carried over from copying)
    // is still well short of `total` (8, both passes), so there is genuine
    // remaining work and the ETA has something real to estimate from.
    const firstVerifying = verifyingSnapshots[0] as ProgressSnapshot;
    expect(firstVerifying.total).toBe(8);
    expect(firstVerifying.done).toBe(4);
  });

  it("aborts and keeps the old primary when a source object does not match its recorded hash", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `bad-source-${tenantId}`);
    const destDir = join(root, `bad-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    const content = Buffer.from("pack bytes as originally written");
    const packId = randomUUID();
    const path = packKey(tenantId, packId);
    await sourceBackend.put(path, content);
    // The catalog's recorded hash no longer matches what is on disk (bit rot,
    // or a byte-for-byte-different file with the same length).
    await db.insert(packs).values({
      tenantId,
      path,
      size: content.length,
      sha256: sha256(Buffer.from("not the same bytes, same length!")).toString("hex"),
    });
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    const ctx = await contextFor(tenantId, migration.id);
    // A verification mismatch is a fact about the data, not a transient
    // condition: the job rejects without retrying (InvalidPayloadError, the
    // framework's "do not retry this" signal), so a caller (the framework's
    // runJob) records the underlying `jobs` row as failed too instead of
    // completed.
    const error = await storageMigrationHandler
      .run(ctx, payloadFor(tenantId, migration.id))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("InvalidPayloadError");

    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.find((r) => r.id === source.id)?.role).toBe("primary");
    expect(rows.find((r) => r.id === destination.id)?.role).toBe("copy");

    const [finished] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    expect(finished?.status).toBe("failed");
    expect(finished?.errorMessage).toContain("source_corrupt");

    const audited = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    expect(audited.some((entry) => entry.action === "storage.migration.verify_failed")).toBe(true);
  });

  // It waits through the real retry delays of five failing objects: 4 s alone, 4.6 s in a
  // CI-like full run, past vitest's 5 s default on a busier machine.
  it("stops a pass early after repeated consecutive failures instead of retrying every item against a dead destination", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `dead-dest-source-${tenantId}`);
    const destDir = join(root, `dead-dest-target-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    // A plain file where the target's basePath should be a directory: every
    // read or write into it fails (ENOTDIR), the same for any user running
    // the test — unlike a permission-denied directory, which root bypasses —
    // a portable stand-in for a destination that is simply unreachable.
    await writeFile(destDir, "not a directory");
    const destination = await addTarget(tenantId, "copy", destDir);

    // Comfortably more packs than MAX_CONSECUTIVE_FAILURES (5): if the pass
    // did not stop early, it would still churn through every one of them.
    const packCount = 12;
    for (let i = 0; i < packCount; i++) {
      const content = Buffer.from(`pack content number ${i}`);
      const path = packKey(tenantId, randomUUID());
      await sourceBackend.put(path, content);
      await db
        .insert(packs)
        .values({ tenantId, path, size: content.length, sha256: sha256(content).toString("hex") });
    }

    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));
    const ctx = await contextFor(tenantId, migration.id);
    const error = await storageMigrationHandler
      .run(ctx, payloadFor(tenantId, migration.id))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("InvalidPayloadError");

    const [finished] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    expect(finished?.status).toBe("failed");
    expect(finished?.errorMessage).toContain("Stopped after repeated failures");
    // It gave up well short of working through every pack.
    expect(finished?.objectsDone as number).toBeLessThan(packCount);
    expect(finished?.objectsDone as number).toBeLessThanOrEqual(5);
  }, 30_000);

  it("resumes from a checkpoint instead of restarting: an already-copied object is not re-fetched needlessly", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `resume-source-${tenantId}`);
    const destDir = join(root, `resume-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const destBackend = new LocalStorageBackend(destDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    const seeded = await seedSource(tenantId, sourceBackend);
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "copying", startedAt: new Date("2026-09-24T09:00:00.000Z") })
      .where(eq(storageMigrations.id, migration.id));

    // Simulate a first attempt that got partway through: the manifest and the
    // wrapped key (the two lexically-first keys, "tenants/.../keys/..." and
    // "tenants/.../manifests/...") are already on the destination, and the
    // job's own checkpoint says so.
    await destBackend.put(seeded.key, await sourceBackend.get(seeded.key));
    await destBackend.put(seeded.manifest, await sourceBackend.get(seeded.manifest));
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "storage_migration",
      status: "active",
      payload: { jobId, tenantId, migrationId: migration.id },
      startedAt: new Date(),
    });
    const cursor = new PgCursorStore(tenantRunner(db, tenantId), jobId);
    await cursor.save({ phase: "copying", lastKey: seeded.manifest });

    const ctx = { ...(await contextFor(tenantId, migration.id)), jobId, cursor };
    const outcome = await storageMigrationHandler.run(ctx, payloadFor(tenantId, migration.id));
    expect(outcome?.summary).toMatchObject({ status: "completed" });

    for (const packId of seeded.packIds) {
      expect(await destBackend.get(packKey(tenantId, packId))).toEqual(
        await sourceBackend.get(packKey(tenantId, packId)),
      );
    }
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.find((r) => r.id === destination.id)?.role).toBe("primary");
  });

  it("stops between objects when cancelled, leaving the old primary untouched", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `cancel-source-${tenantId}`);
    const destDir = join(root, `cancel-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    await seedSource(tenantId, sourceBackend);
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    // The API sets this reason when it flips `jobs.status` to cancelled and
    // the framework's cancel poll notices (framework.ts, `abortReasonOf`); a
    // bare `abort()` (no reason) is what a graceful shutdown looks like, see
    // the next test.
    const controller = new AbortController();
    controller.abort("cancelled");
    const ctx = { ...(await contextFor(tenantId, migration.id)), signal: controller.signal };
    const error = await storageMigrationHandler
      .run(ctx, payloadFor(tenantId, migration.id))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);

    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.find((r) => r.id === source.id)?.role).toBe("primary");
    expect(rows.find((r) => r.id === destination.id)?.role).toBe("copy");
    const [finished] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    expect(finished?.status).toBe("cancelled");

    const audited = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const cancelled = audited.find((entry) => entry.action === "storage.migration.cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled?.details).toMatchObject({ migrationId: migration.id, duringWorkerRun: true });
  });

  it("does not cancel the migration on a worker shutdown or an expiring lease: it resumes instead", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `shutdown-source-${tenantId}`);
    const destDir = join(root, `shutdown-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    const seeded = await seedSource(tenantId, sourceBackend);
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    // A graceful shutdown (framework.ts: `controller.abort("shutdown")` from
    // its own shutdown signal) or an about-to-expire pg-boss lease
    // (`abort("expired")`) is not an admin's cancellation.
    const controller = new AbortController();
    controller.abort("shutdown");
    const ctx = { ...(await contextFor(tenantId, migration.id)), signal: controller.signal };
    const error = await storageMigrationHandler
      .run(ctx, payloadFor(tenantId, migration.id))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe("InvalidPayloadError");

    const [interrupted] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    // Left exactly as it was: still in flight, not cancelled or failed, so the
    // framework's own retry (which keeps `jobs.cursor` for a non-terminal
    // status) resumes it.
    expect(interrupted?.status).toBe("copying");
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.find((r) => r.id === source.id)?.role).toBe("primary");

    // The retry: a fresh, non-aborted context resumes from the checkpoint and completes.
    const resumeCtx = await contextFor(tenantId, migration.id);
    const outcome = await storageMigrationHandler.run(
      resumeCtx,
      payloadFor(tenantId, migration.id),
    );
    expect(outcome?.summary).toMatchObject({ status: "completed" });
    const destBackend = new LocalStorageBackend(destDir);
    for (const packId of seeded.packIds) {
      expect(await destBackend.get(packKey(tenantId, packId))).toEqual(
        await sourceBackend.get(packKey(tenantId, packId)),
      );
    }
    const finishedRows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(finishedRows.find((r) => r.id === destination.id)?.role).toBe("primary");
  });

  it("copies packs left over from an earlier 'keep' replacement (keep, then move)", async () => {
    const tenantId = await createTenant();
    // An earlier "keep" replacement: the retired target still holds a pack no
    // longer reachable from the current primary.
    const retiredDir = join(root, `retired-${tenantId}`);
    const retiredBackend = new LocalStorageBackend(retiredDir);
    const legacyContent = Buffer.from("a pack from before the earlier keep switch");
    const legacyPackId = randomUUID();
    const legacyPath = packKey(tenantId, legacyPackId);
    await retiredBackend.put(legacyPath, legacyContent);
    await db.insert(packs).values({
      tenantId,
      path: legacyPath,
      size: legacyContent.length,
      sha256: sha256(legacyContent).toString("hex"),
    });
    const retired = await addTarget(tenantId, "copy", retiredDir);
    await db
      .update(storageTargets)
      .set({ role: "previous" })
      .where(eq(storageTargets.id, retired.id));

    const sourceDir = join(root, `keepmove-source-${tenantId}`);
    const destDir = join(root, `keepmove-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    // The current primary only has what was written since the keep switch.
    const seeded = await seedSource(tenantId, sourceBackend);

    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    const ctx = await contextFor(tenantId, migration.id);
    const outcome = await storageMigrationHandler.run(ctx, payloadFor(tenantId, migration.id));
    expect(outcome?.summary).toMatchObject({ status: "completed" });

    const destBackend = new LocalStorageBackend(destDir);
    // Both the packs the current primary always had, and the one that only
    // ever lived on the retired "previous" target, arrived on the destination.
    for (const packId of seeded.packIds) {
      expect(await destBackend.get(packKey(tenantId, packId))).toEqual(
        await sourceBackend.get(packKey(tenantId, packId)),
      );
    }
    expect(await destBackend.get(legacyPath)).toEqual(legacyContent);
  });

  it("waits for an active backup job of the tenant before switching the primary", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `wait-source-${tenantId}`);
    const destDir = join(root, `wait-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    await seedSource(tenantId, sourceBackend);
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    // A backup already running when the migration started: the final
    // reconciliation pass (file doc comment) must wait it out instead of
    // switching while it might still write only to the old primary.
    const backupJobId = randomUUID();
    await db.insert(jobs).values({
      id: backupJobId,
      tenantId,
      queue: "backup",
      status: "active",
      payload: { jobId: backupJobId, tenantId },
      startedAt: new Date(),
    });

    const ctx = await contextFor(tenantId, migration.id);
    const runPromise = storageMigrationHandler.run(ctx, payloadFor(tenantId, migration.id));
    // Give the migration time to reach the "waiting" reconciliation round
    // before the backup job ends.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await db
      .update(jobs)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(jobs.id, backupJobId));

    const outcome = await runPromise;
    expect(outcome?.summary).toMatchObject({ status: "completed" });
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.find((r) => r.id === destination.id)?.role).toBe("primary");
  }, 20_000);

  it("waits for worker storage caches to notice the destination before switching, then completes", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `settle-source-${tenantId}`);
    const destDir = join(root, `settle-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    // A fixed, explicit `createdAt` instead of "a moment ago": the wait
    // compares `now` against it, so both sides are under the test's control
    // and nothing here depends on how fast the surrounding suite happens to
    // run.
    const destinationCreatedAt = new Date("2026-09-24T09:00:00.000Z");
    const destination = await addTarget(tenantId, "copy", destDir, destinationCreatedAt);
    await seedSource(tenantId, sourceBackend);
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    process.env.RESTOW_STORAGE_CACHE_SETTLE_MS = "300";
    // 100 ms after the destination was "created": well inside the 300 ms settle window.
    const ctx = {
      ...(await contextFor(tenantId, migration.id)),
      now: () => new Date(destinationCreatedAt.getTime() + 100),
    };
    const tooSoon = await storageMigrationHandler
      .run(ctx, payloadFor(tenantId, migration.id))
      .catch((e: unknown) => e);
    expect(tooSoon).toBeInstanceOf(Error);
    expect((tooSoon as Error).message).toContain("waiting");
    expect((tooSoon as Error).name).not.toBe("InvalidPayloadError");

    // Not failed, not switched: still verifying, waiting to be retried.
    const [stillWaiting] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    expect(stillWaiting?.status).toBe("verifying");
    const rowsBeforeSettled = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rowsBeforeSettled.find((r) => r.id === source.id)?.role).toBe("primary");

    // 400 ms after "creation": past the 300 ms settle window.
    const resumeCtx = {
      ...(await contextFor(tenantId, migration.id)),
      now: () => new Date(destinationCreatedAt.getTime() + 400),
    };
    const outcome = await storageMigrationHandler.run(
      resumeCtx,
      payloadFor(tenantId, migration.id),
    );
    expect(outcome?.summary).toMatchObject({ status: "completed" });
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.find((r) => r.id === destination.id)?.role).toBe("primary");
    expect(rows.find((r) => r.id === source.id)?.role).toBe("previous");
  }, 20_000);

  it("mirrors a manifest and pack written to the source only between two executions before switching, even though both sort below the resumed checkpoint", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `gap-source-${tenantId}`);
    const destDir = join(root, `gap-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const destBackend = new LocalStorageBackend(destDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destinationCreatedAt = new Date("2026-09-24T09:00:00.000Z");
    const destination = await addTarget(tenantId, "copy", destDir, destinationCreatedAt);
    const seeded = await seedSource(tenantId, sourceBackend);
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    // Both executions are the same underlying pg-boss job retried — exactly
    // what a real settle-wait-then-retry is — sharing one `jobId` and cursor,
    // the same way "resumes from a checkpoint instead of restarting" above
    // does. Two separate `contextFor` calls (as the settle-wait test above
    // uses) would each start a *different* job with its own, empty cursor,
    // so the second call would never actually resume from a checkpoint at
    // all — it would just reprocess everything from scratch and miss the
    // very bug this test exists to catch.
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "storage_migration",
      status: "active",
      payload: { jobId, tenantId, migrationId: migration.id },
      startedAt: new Date(),
    });
    const cursor = new PgCursorStore(tenantRunner(db, tenantId), jobId);

    // First execution, 100 ms after the destination was "created": well
    // inside the 300 ms settle window (same trick as the test above). It
    // copies and verifies everything seeded above, then hits the settle wait
    // and stops without switching. `migration.status` is left "verifying",
    // with the shared job's cursor now holding the largest key among the
    // two seeded packs — the same situation the file doc comment (3.
    // reconciliation) and the accompanying finding describe as the normal
    // resume path, not an edge case.
    process.env.RESTOW_STORAGE_CACHE_SETTLE_MS = "300";
    const firstCtx = {
      ...(await contextFor(tenantId, migration.id)),
      jobId,
      cursor,
      now: () => new Date(destinationCreatedAt.getTime() + 100),
    };
    const firstAttempt = await storageMigrationHandler
      .run(firstCtx, payloadFor(tenantId, migration.id))
      .catch((e: unknown) => e);
    expect(firstAttempt).toBeInstanceOf(Error);
    expect((firstAttempt as Error).message).toContain("waiting");
    const [afterFirstAttempt] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    expect(afterFirstAttempt?.status).toBe("verifying");
    for (const key of [seeded.manifest, seeded.key]) {
      expect(await destBackend.get(key)).toEqual(await sourceBackend.get(key));
    }

    // Between the two executions, a backup writes a new manifest and a new
    // pack to the source only — exactly what the destination never receives
    // without this job copying it. Both are crafted to sort below the
    // checkpoint's `lastKey` (the larger of the two original pack keys): a
    // manifest always does ("manifests/" sorts before "packs/"), and this
    // pack's id is chosen so its shard ("00/...") sorts before any of the
    // seeded packs' random shards.
    const newPackId = `00${randomUUID().slice(2)}`;
    const newPackContent = Buffer.from("pack written between the two executions");
    const newPackPath = packKey(tenantId, newPackId);
    await sourceBackend.put(newPackPath, newPackContent);
    await db.insert(packs).values({
      tenantId,
      path: newPackPath,
      size: newPackContent.length,
      sha256: sha256(newPackContent).toString("hex"),
    });
    const newSnapshotId = randomUUID();
    const newManifestPath = manifestKey(tenantId, newSnapshotId);
    await sourceBackend.put(newManifestPath, Buffer.from('{"objects":[]}'));
    await seedLiveSnapshot(tenantId, newSnapshotId, newManifestPath);
    expect(await destBackend.head(newPackPath)).toBeNull();
    expect(await destBackend.head(newManifestPath)).toBeNull();

    // Second execution, 400 ms after "creation": past the settle window.
    // Same job, same cursor — a real resume. Must still find and mirror both
    // new objects before switching, not silently treat them as already done
    // because their keys sort below the checkpoint.
    const resumeCtx = {
      ...(await contextFor(tenantId, migration.id)),
      jobId,
      cursor,
      now: () => new Date(destinationCreatedAt.getTime() + 400),
    };
    const outcome = await storageMigrationHandler.run(
      resumeCtx,
      payloadFor(tenantId, migration.id),
    );
    expect(outcome?.summary).toMatchObject({ status: "completed" });

    expect(await destBackend.get(newPackPath)).toEqual(newPackContent);
    expect(await destBackend.get(newManifestPath)).toEqual(
      await sourceBackend.get(newManifestPath),
    );
    for (const packId of seeded.packIds) {
      expect(await destBackend.get(packKey(tenantId, packId))).toEqual(
        await sourceBackend.get(packKey(tenantId, packId)),
      );
    }
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.find((r) => r.id === destination.id)?.role).toBe("primary");
    expect(rows.find((r) => r.id === source.id)?.role).toBe("previous");
  }, 20_000);

  it("fails the migration instead of switching when the source is no longer the primary", async () => {
    const tenantId = await createTenant();
    const sourceDir = join(root, `raced-source-${tenantId}`);
    const otherDir = join(root, `raced-other-${tenantId}`);
    const destDir = join(root, `raced-dest-${tenantId}`);
    const sourceBackend = new LocalStorageBackend(sourceDir);
    const source = await addTarget(tenantId, "primary", sourceDir);
    const destination = await addTarget(tenantId, "copy", destDir);
    await seedSource(tenantId, sourceBackend);
    const migration = await addMigration(tenantId, source.id, destination.id);
    await db
      .update(storageMigrations)
      .set({ status: "queued" })
      .where(eq(storageMigrations.id, migration.id));

    // Something else made a different target the primary while this job's
    // copy and verify passes ran (`rules.ts` refuses this through the API
    // while a migration is unfinished; this simulates a race that slips past
    // it, or a row changed directly): the source this job opened is now a
    // plain copy, and another row holds "primary".
    const other = await addTarget(tenantId, "copy", otherDir);
    await db.update(storageTargets).set({ role: "copy" }).where(eq(storageTargets.id, source.id));
    await db.update(storageTargets).set({ role: "primary" }).where(eq(storageTargets.id, other.id));

    const ctx = await contextFor(tenantId, migration.id);
    const error = await storageMigrationHandler
      .run(ctx, payloadFor(tenantId, migration.id))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("InvalidPayloadError");

    const [finished] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    expect(finished?.status).toBe("failed");
    expect(finished?.errorMessage).toContain("no longer the tenant's primary");

    // Untouched: neither role the job would have set was applied.
    const rows = await db
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId));
    expect(rows.find((r) => r.id === destination.id)?.role).toBe("copy");
    expect(rows.find((r) => r.id === source.id)?.role).toBe("copy");
    expect(rows.find((r) => r.id === other.id)?.role).toBe("primary");
  });

  it("is a no-op for 'keep' migrations: the API already switched them synchronously", async () => {
    const tenantId = await createTenant();
    const destination = await addTarget(tenantId, "primary", join(root, `keep-${tenantId}`));
    const [migration] = await db
      .insert(storageMigrations)
      .values({
        tenantId,
        sourceTargetId: null,
        destinationTargetId: destination.id,
        mode: "keep",
        status: "completed",
      })
      .returning();
    const ctx = await contextFor(tenantId, migration?.id as string);
    const outcome = await storageMigrationHandler.run(
      ctx,
      payloadFor(tenantId, migration?.id as string),
    );
    expect(outcome?.summary).toMatchObject({ skipped: true, mode: "keep" });
  });

  it("hasActiveMigration reports only unfinished migrations", async () => {
    const tenantId = await createTenant();
    const destination = await addTarget(tenantId, "copy", join(root, `active-${tenantId}`));
    expect(await hasActiveMigration(tenantRunner(db, tenantId), tenantId)).toBe(false);
    const migration = await addMigration(tenantId, null, destination.id);
    expect(await hasActiveMigration(tenantRunner(db, tenantId), tenantId)).toBe(true);
    await db
      .update(storageMigrations)
      .set({ status: "failed" })
      .where(eq(storageMigrations.id, migration.id));
    expect(await hasActiveMigration(tenantRunner(db, tenantId), tenantId)).toBe(false);
  });

  it("hasActiveMigration stops blocking once a migration's job has died for good, even though its own row is still 'copying'", async () => {
    const tenantId = await createTenant();
    const destination = await addTarget(tenantId, "copy", join(root, `stalled-${tenantId}`));
    const migration = await addMigration(tenantId, null, destination.id);
    expect(await hasActiveMigration(tenantRunner(db, tenantId), tenantId)).toBe(true);

    // The job exhausted its retries (an unreachable destination, say) but
    // nothing reconciled the migration row yet: it still reads "copying".
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "storage_migration",
      status: "failed",
      payload: { jobId, tenantId, migrationId: migration.id },
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: "destination unreachable",
    });
    await db.update(storageMigrations).set({ jobId }).where(eq(storageMigrations.id, migration.id));

    expect(await hasActiveMigration(tenantRunner(db, tenantId), tenantId)).toBe(false);
    const [row] = await db
      .select()
      .from(storageMigrations)
      .where(eq(storageMigrations.id, migration.id));
    expect(row?.status).toBe("copying");
  });

  it("hasActiveMigration keeps blocking while the job is still queued or active", async () => {
    const tenantId = await createTenant();
    const destination = await addTarget(tenantId, "copy", join(root, `live-${tenantId}`));
    const migration = await addMigration(tenantId, null, destination.id);
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      tenantId,
      queue: "storage_migration",
      status: "active",
      payload: { jobId, tenantId, migrationId: migration.id },
      startedAt: new Date(),
    });
    await db.update(storageMigrations).set({ jobId }).where(eq(storageMigrations.id, migration.id));
    expect(await hasActiveMigration(tenantRunner(db, tenantId), tenantId)).toBe(true);
  });
});
