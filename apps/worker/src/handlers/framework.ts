/**
 * The worker job framework.
 *
 * A {@link JobHandler} is the unit every queue plugs in: it receives a fully
 * built {@link WorkerJobContext} (storage, keyring, indexes, progress, cursor,
 * logger, abort signal) and the typed payload, and returns when the work is
 * done. Everything around it lives here:
 *
 *   - tenant pinning: every database access runs in a transaction that sets
 *     `app.tenant_id`, so Row Level Security applies to the worker as well
 *   - the Postgres implementations of the core seams (chunk index, snapshot
 *     index, cursor store) and the tenant keyring cache
 *   - the `jobs` lifecycle row (queued -> active -> completed/failed/cancelled),
 *     with the cursor kept across retries so a restarted job resumes
 *   - per-tenant concurrency, cancellation (API flips the row, the runner
 *     aborts the engine) and graceful shutdown (abort, checkpoint, retry later)
 *   - structured logs without secrets or payloads
 */
import {
  type ChunkIndex,
  type ChunkLocation,
  type ChunkRecord,
  type CompleteSnapshotInput,
  type Cursor,
  type CursorStore,
  type FailureCause,
  JobAbortedError,
  type JobContext,
  type JobPayload,
  type JobPayloads,
  type KeyProvider,
  Keyring,
  LocalStorageBackend,
  type LogFields,
  type Logger,
  type ManifestObject,
  type NewSnapshotRecord,
  type PackRecord,
  type ProtectedObjectRef,
  type S3CredentialsSecret,
  S3StorageBackend,
  type SecretReader,
  type SnapshotIndex,
  type SnapshotRecord,
  type StorageBackend,
  type StorageTargets,
  type TenantKeyring,
  discardUncommittedSnapshot,
  redactSensitiveText,
  sealedAad,
  secretAad,
  withReadOnlyFallback,
  wrappedKeyKey,
} from "@restow/core";
import {
  type Database,
  type FailureRecordJson,
  type Job,
  type ManifestObjectKind,
  type NewManifestObjectRow,
  type StorageTarget,
  chunks,
  jobs,
  manifestObjects,
  packs,
  protectedObjects,
  reportableError,
  secrets,
  snapshots,
  sources,
  storageMigrations,
  storageTargets,
  tenantKeys,
} from "@restow/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { isSourceScopedCause, jobFailureRecord, retryStateOf } from "../failure.js";
import { createProgressReporter } from "../progress.js";
import type { TenantTx, TenantTxRunner } from "../progress.js";
import type { QueueName } from "../queues.js";

type JobStatus = Job["status"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSERT_BATCH = 1000;
const KEYRING_TTL_MS = 5 * 60 * 1000;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

// ---------------------------------------------------------------------------
// Tenant-pinned transactions
// ---------------------------------------------------------------------------

/**
 * Run `fn` in a transaction with `app.tenant_id` set for RLS. `set_config` with
 * `is_local = true` scopes the setting to the transaction, so a pooled
 * connection never leaks one tenant into the next job.
 */
export async function withTenantTx<T>(
  db: Database,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!isUuid(tenantId)) {
    throw new Error("tenant id must be a uuid");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

export function tenantRunner(db: Database, tenantId: string): TenantTxRunner {
  return (fn) => withTenantTx(db, tenantId, fn);
}

// ---------------------------------------------------------------------------
// Postgres implementations of the core seams
// ---------------------------------------------------------------------------

function countOccurrences(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export class PgChunkIndex implements ChunkIndex {
  constructor(
    private readonly run: TenantTxRunner,
    private readonly tenantId: string,
  ) {}

  /** Chunks in packs the scrub marked damaged do not count: a backup writes them again. */
  async existing(storedIds: readonly string[]): Promise<Set<string>> {
    if (storedIds.length === 0) {
      return new Set();
    }
    const rows = await this.run((tx) =>
      tx
        .select({ storedId: chunks.storedId })
        .from(chunks)
        .innerJoin(packs, eq(chunks.packId, packs.id))
        .where(
          and(
            eq(chunks.tenantId, this.tenantId),
            inArray(chunks.storedId, [...storedIds]),
            isNull(packs.damagedAt),
          ),
        ),
    );
    return new Set(rows.map((row) => row.storedId));
  }

  async recordPack(pack: PackRecord, records: readonly ChunkRecord[]): Promise<void> {
    // One row per stored id; the first entry wins, as it does in a pack index.
    const seen = new Set<string>();
    const rows = records.filter((record) => {
      const first = !seen.has(record.storedId);
      seen.add(record.storedId);
      return first;
    });
    await this.run(async (tx) => {
      await tx.insert(packs).values({
        id: pack.id,
        tenantId: this.tenantId,
        path: pack.path,
        sha256: pack.sha256,
        size: pack.size,
      });
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const batch = rows.slice(i, i + INSERT_BATCH).map((record) => ({
          tenantId: this.tenantId,
          storedId: record.storedId,
          length: record.length,
          packId: pack.id,
          offsetBytes: record.offset,
        }));
        // A concurrent job of the same tenant may have stored the same chunk in
        // its own pack a moment ago; the first row wins, the duplicate bytes are
        // reclaimed by garbage collection. A row whose pack is marked damaged
        // moves to this intact copy instead; its references stay, and so does
        // updated_at, which dates the last reference change.
        await tx
          .insert(chunks)
          .values(batch)
          .onConflictDoUpdate({
            target: [chunks.tenantId, chunks.storedId],
            set: {
              packId: sql`excluded.pack_id`,
              offsetBytes: sql`excluded.offset_bytes`,
              length: sql`excluded.length`,
            },
            setWhere: sql`${chunks.packId} IN (SELECT ${packs.id} FROM ${packs} WHERE ${packs.tenantId} = ${this.tenantId}::uuid AND ${packs.damagedAt} IS NOT NULL)`,
          });
      }
    });
  }

  async locate(storedIds: readonly string[]): Promise<Map<string, ChunkLocation>> {
    const result = new Map<string, ChunkLocation>();
    if (storedIds.length === 0) {
      return result;
    }
    const rows = await this.run((tx) =>
      tx
        .select({
          storedId: chunks.storedId,
          offset: chunks.offsetBytes,
          length: chunks.length,
          packPath: packs.path,
        })
        .from(chunks)
        .innerJoin(packs, eq(chunks.packId, packs.id))
        .where(and(eq(chunks.tenantId, this.tenantId), inArray(chunks.storedId, [...storedIds]))),
    );
    for (const row of rows) {
      result.set(row.storedId, row);
    }
    return result;
  }

  async addReferences(storedIds: readonly string[]): Promise<void> {
    await this.adjustReferences(storedIds, +1);
  }

  async releaseReferences(storedIds: readonly string[]): Promise<void> {
    await this.adjustReferences(storedIds, -1);
  }

  private async adjustReferences(storedIds: readonly string[], direction: 1 | -1): Promise<void> {
    const counts = [...countOccurrences(storedIds)];
    if (counts.length === 0) {
      return;
    }
    await this.run(async (tx) => {
      for (let i = 0; i < counts.length; i += INSERT_BATCH) {
        const batch = counts.slice(i, i + INSERT_BATCH);
        const values = sql.join(
          batch.map(([id, n]) => sql`(${id}::text, ${n * direction}::int)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE ${chunks} AS c
          SET refcount = GREATEST(0, c.refcount + v.delta), updated_at = now()
          FROM (VALUES ${values}) AS v(stored_id, delta)
          WHERE c.tenant_id = ${this.tenantId}::uuid AND c.stored_id = v.stored_id
        `);
      }
    });
  }
}

function toSnapshotRecord(row: typeof snapshots.$inferSelect): SnapshotRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    protectedObjectId: row.protectedObjectId,
    jobId: row.jobId,
    sequence: row.sequence,
    manifestPath: row.manifestPath,
    status: row.status,
    itemCount: row.itemCount,
    byteSize: row.byteSize,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

/** Map a manifest entry's `type` onto the `manifest_object_kind` enum. */
export function manifestObjectKind(type: string | undefined): ManifestObjectKind {
  switch (type) {
    case "mail":
    case "message":
      return "mail";
    case "folder":
      return "folder";
    case "event":
      return "event";
    case "contact":
      return "contact";
    default:
      return "file";
  }
}

function splitPath(path: string): { name: string; parentPath: string } {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) {
    return { name: trimmed, parentPath: "" };
  }
  return { name: trimmed.slice(slash + 1), parentPath: trimmed.slice(0, slash) };
}

/** The `manifest_objects` row for one manifest entry. */
export function toManifestObjectRow(
  tenantId: string,
  snapshotId: string,
  protectedObjectId: string,
  object: ManifestObject,
): NewManifestObjectRow {
  const kind = manifestObjectKind(object.type);
  const { name, parentPath } = splitPath(object.path);
  return {
    tenantId,
    snapshotId,
    protectedObjectId,
    kind,
    path: object.path,
    name,
    parentPath,
    size: object.size,
    mtime: object.mtime > 0 ? new Date(object.mtime) : null,
    itemId: object.id ?? null,
    messageId: object.metadata?.messageId ?? null,
    chunkRefs: kind === "folder" ? null : object.chunks,
    metadata: object.metadata ?? null,
  };
}

export class PgSnapshotIndex implements SnapshotIndex {
  constructor(
    private readonly run: TenantTxRunner,
    private readonly tenantId: string,
    private readonly logger: Logger,
  ) {}

  async latestCompleted(protectedObjectId: string): Promise<SnapshotRecord | null> {
    const [row] = await this.run((tx) =>
      tx
        .select()
        .from(snapshots)
        .where(
          and(
            eq(snapshots.tenantId, this.tenantId),
            eq(snapshots.protectedObjectId, protectedObjectId),
            eq(snapshots.status, "active"),
            sql`${snapshots.manifestPath} IS NOT NULL`,
          ),
        )
        .orderBy(desc(snapshots.sequence))
        .limit(1),
    );
    return row ? toSnapshotRecord(row) : null;
  }

  async get(snapshotId: string): Promise<SnapshotRecord | null> {
    const [row] = await this.run((tx) =>
      tx
        .select()
        .from(snapshots)
        .where(and(eq(snapshots.tenantId, this.tenantId), eq(snapshots.id, snapshotId)))
        .limit(1),
    );
    return row ? toSnapshotRecord(row) : null;
  }

  async nextSequence(protectedObjectId: string): Promise<number> {
    const [row] = await this.run((tx) =>
      tx
        .select({ max: sql<number>`coalesce(max(${snapshots.sequence}), 0)::int` })
        .from(snapshots)
        .where(
          and(
            eq(snapshots.tenantId, this.tenantId),
            eq(snapshots.protectedObjectId, protectedObjectId),
          ),
        ),
    );
    return Number(row?.max ?? 0) + 1;
  }

  async create(input: NewSnapshotRecord): Promise<SnapshotRecord> {
    const [row] = await this.run((tx) =>
      tx
        .insert(snapshots)
        .values({
          id: input.id,
          tenantId: this.tenantId,
          protectedObjectId: input.protectedObjectId,
          jobId: input.jobId,
          sequence: input.sequence,
          startedAt: input.startedAt,
        })
        .returning(),
    );
    return toSnapshotRecord(row);
  }

  async complete(snapshotId: string, input: CompleteSnapshotInput): Promise<void> {
    await this.run((tx) =>
      tx
        .update(snapshots)
        .set({
          manifestPath: input.manifestPath,
          itemCount: input.itemCount,
          byteSize: input.byteSize,
          completedAt: input.completedAt,
        })
        .where(and(eq(snapshots.tenantId, this.tenantId), eq(snapshots.id, snapshotId))),
    );
  }

  /**
   * Mirror the manifest into `manifest_objects` for the restore explorer and
   * search. Idempotent per snapshot: rows from an earlier attempt are replaced,
   * so a retried commit never leaves duplicates.
   */
  async recordObjects(snapshotId: string, objects: readonly ManifestObject[]): Promise<void> {
    const record = await this.get(snapshotId);
    if (!record) {
      throw new Error(`snapshot ${snapshotId} does not exist`);
    }
    await this.run(async (tx) => {
      await tx
        .delete(manifestObjects)
        .where(
          and(
            eq(manifestObjects.tenantId, this.tenantId),
            eq(manifestObjects.snapshotId, snapshotId),
          ),
        );
      for (let i = 0; i < objects.length; i += INSERT_BATCH) {
        const rows = objects
          .slice(i, i + INSERT_BATCH)
          .map((object) =>
            toManifestObjectRow(this.tenantId, snapshotId, record.protectedObjectId, object),
          );
        await tx.insert(manifestObjects).values(rows);
      }
    });
    this.logger.debug("manifest objects mirrored", { snapshotId, objects: objects.length });
  }

  async discard(snapshotId: string): Promise<void> {
    await this.run((tx) =>
      tx
        .delete(snapshots)
        .where(
          and(
            eq(snapshots.tenantId, this.tenantId),
            eq(snapshots.id, snapshotId),
            isNull(snapshots.manifestPath),
          ),
        ),
    );
  }
}

export class PgCursorStore implements CursorStore {
  constructor(
    private readonly run: TenantTxRunner,
    private readonly jobId: string,
  ) {}

  async load(): Promise<Cursor | null> {
    const [row] = await this.run((tx) =>
      tx.select({ cursor: jobs.cursor }).from(jobs).where(eq(jobs.id, this.jobId)).limit(1),
    );
    return (row?.cursor as Cursor | null | undefined) ?? null;
  }

  async save(cursor: Cursor): Promise<void> {
    await this.run((tx) => tx.update(jobs).set({ cursor }).where(eq(jobs.id, this.jobId)));
  }

  async clear(): Promise<void> {
    await this.run((tx) => tx.update(jobs).set({ cursor: null }).where(eq(jobs.id, this.jobId)));
  }
}

// ---------------------------------------------------------------------------
// Snapshots nothing will resume
// ---------------------------------------------------------------------------
//
// A failed or interrupted backup checkpoints its partial manifest so the retry
// resumes. A job that ended for good (completed, failed after its last retry,
// cancelled) clears its cursor, so nothing ever resumes that checkpoint
// again. Left alone, its partial manifest would keep every chunk it names out
// of garbage collection forever, an unreadable one would stop collection for
// the whole tenant, and the in-progress row would read as "running" forever.

/** Job states after which the job never runs again, so never resumes a checkpoint. */
const FINAL_JOB_STATUSES: readonly JobStatus[] = ["completed", "failed", "cancelled"];

/** Queues whose jobs write (and checkpoint) snapshots. */
const SNAPSHOT_QUEUES: ReadonlySet<QueueName> = new Set<QueueName>(["backup", "import"]);

/**
 * Queues that may read a "keep"-retired primary through its read-only
 * fallback (docs/STORAGE.md, "Replace the primary"): a restore or a verify
 * job needs the object exactly as it is, wherever it still lives. `backup`
 * also reads it, though it never writes anything through the fallback wrapper
 * itself: every engine's incremental run calls
 * `SnapshotWriter.loadPreviousManifest()` (core `engine/snapshot.ts`) to carry
 * unchanged objects forward and dedupe against what the last backup already
 * stored, and after a "keep" switch that previous manifest lives only on the
 * retired target. Without this, every later backup of an object whose last
 * snapshot predates the switch would fail permanently with "object ... is not
 * readable from any storage target" — `withReadOnlyFallback` never changes
 * where a `put`/`delete` through it goes (always the real primary passed in),
 * only where a miss on a read falls through to `previous`. `restore` is the
 * one member of this set whose engine also writes through the wrapped
 * primary directly (the download engine's ZIP export, core
 * `restore/download.ts`), which is why it is in `STORAGE_WRITE_QUEUES` below
 * as well: that keeps its cached primary from going stale across a "keep"
 * switch, so the wrapper it writes through is never the just-retired target.
 * `archive` never reads the primary at all (it only writes); `scrub` is
 * deliberately left out even though it reads, because folding `previous` into
 * its primary would let a real corruption on the current primary hide behind
 * a stale copy scrub never looks at (scrub already has its own, narrower
 * handling for a "keep"-retired primary, `LegacyExcludingPackCatalog`).
 */
const READ_ONLY_FALLBACK_QUEUES: ReadonlySet<QueueName> = new Set<QueueName>([
  "backup",
  "restore",
  "verify",
  // An import carries the previous snapshot forward (like a backup); an export reads
  // snapshots and archive chunks and writes its file through the wrapped primary.
  "import",
  "export",
]);

/**
 * The `StorageTargets` a job on `queue` should use: for `backup`, `restore`
 * and `verify`, `primary` wrapped so a read that misses on it falls through to
 * any `previous` target (`withReadOnlyFallback`, never a write — see
 * `READ_ONLY_FALLBACK_QUEUES`); every other queue gets `resolved` back
 * unchanged. `resolved` comes from `runtime.storage`'s cache, typed as the
 * plain `StorageTargets` its other callers (`mirrorTenantKeys` among them)
 * only ever needed; the cast recovers the `previous` field
 * `resolveTenantStorage` actually put there. A `previous`-less
 * `StorageTargets` (every tenant without a "keep" replacement, and any
 * fixture that builds one directly) costs nothing extra: `withReadOnlyFallback`
 * returns `primary` itself when there is nothing to fall back to.
 */
export function storageForQueue(resolved: StorageTargets, queue: QueueName): StorageTargets {
  if (!READ_ONLY_FALLBACK_QUEUES.has(queue)) {
    return resolved;
  }
  const previous = (resolved as Partial<ResolvedTenantStorage>).previous ?? [];
  return { ...resolved, primary: withReadOnlyFallback(resolved.primary, previous) };
}

/**
 * Queues whose jobs write to, or delete from, the tenant's primary storage
 * target (mirrors `STORAGE_WRITING_QUEUES` in apps/api/src/features/storage/
 * service.ts, which the api process cannot import from here). `restore` is
 * here for its download engine's ZIP export (core `restore/download.ts`,
 * `ctx.storage.primary.put`/`.delete`), which writes through the wrapped
 * primary from `READ_ONLY_FALLBACK_QUEUES` rather than only reading through
 * it; granular and full-mailbox restore on the same queue never write to
 * storage at all, only through Graph/IMAP, so including the whole queue costs
 * them nothing but the one cheap staleness check below. `verify` only reads
 * (through `READ_ONLY_FALLBACK_QUEUES`); `directory` touches no storage at
 * all.
 */
const STORAGE_WRITE_QUEUES: ReadonlySet<QueueName> = new Set<QueueName>([
  "backup",
  "archive",
  "retention",
  "scrub",
  "storage_migration",
  "restore",
  "import",
  "export",
]);

/**
 * The most recent "keep" replacement's switch time for `tenantId`, or null if
 * it never had one, read on an already-open transaction. The shared body of
 * {@link latestKeepSwitchAt} and `resolveTenantStorage`'s own read of the same
 * value, so both go through one query.
 */
async function latestKeepSwitchAtTx(tx: TenantTx, tenantId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ switchedAt: storageMigrations.switchedAt })
    .from(storageMigrations)
    .where(and(eq(storageMigrations.tenantId, tenantId), eq(storageMigrations.mode, "keep")))
    .orderBy(desc(storageMigrations.switchedAt))
    .limit(1);
  return row?.switchedAt ?? null;
}

/** The most recent "keep" replacement's switch time for `tenantId`, or null if it never had one. */
async function latestKeepSwitchAt(run: TenantTxRunner, tenantId: string): Promise<Date | null> {
  return run((tx) => latestKeepSwitchAtTx(tx, tenantId));
}

/**
 * Whether two "keep" switch markers name the same generation: both null (the
 * tenant never had one), or the same instant. Equality, never ordering — see
 * {@link resolveStorageForJob} for why an ordering comparison is the wrong
 * tool here.
 */
function sameGeneration(a: Date | null, b: Date | null): boolean {
  return a === null ? b === null : b !== null && a.getTime() === b.getTime();
}

/**
 * The `StorageTargets` `runJob` should resolve for `queue`, never a cache
 * entry from before the tenant's most recent "keep" replacement switched
 * primaries (docs/STORAGE.md, "Replace the primary"). A worker process that
 * resolved and cached `StorageTargets` shortly before an admin's "keep"
 * switch keeps serving that snapshot — the old primary — for up to the
 * cache's TTL; without this check a job dispatched to a write queue
 * (`STORAGE_WRITE_QUEUES`) in that window would still write to the
 * just-retired target, which is now the read-only "previous" one (see
 * `apps/api/src/features/storage/service.ts`'s `hasActiveWriteJob`, which
 * closes the other half of this window by refusing the switch itself while
 * a write job is already queued or active). One cheap indexed query per
 * write-queue job, only ever followed by a cache reload when it finds the
 * cached entry actually is stale; every other queue skips it and reads the
 * plain cache.
 *
 * This compares two values that both come from Postgres — the cached entry's
 * own `keepGeneration` (`ResolvedTenantStorage`, stamped inside the same
 * transaction that read the `storage_targets` rows it describes) against a
 * freshly read current one — for equality, never a cached `loadedAt` against
 * `switchedAt`. That comparison used to mix the worker's own clock (stamped
 * only once the loader, including `mirrorTenantKeys`'s S3 round trips, had
 * fully resolved) with the API process's clock, and stamping `loadedAt` after
 * rather than before the loader ran meant a switch that landed while the
 * loader was still running could be missed entirely: `loadedAt` would already
 * read later than `switchedAt` by the time it was recorded, so the entry
 * looked fresh even though it held the just-retired primary. Comparing two
 * database-sourced generations sidesteps both problems; it does not, on its
 * own, close the narrower window where this check's own read of the current
 * generation happens to land inside the API's still-uncommitted switch
 * transaction (see `ResolvedTenantStorage.keepGeneration`).
 */
export async function resolveStorageForJob(options: {
  readonly tenantId: string;
  readonly queue: QueueName;
  readonly storage: TenantCache<StorageTargets>;
  /**
   * The tenant's most recent "keep" switch time, or null if it never had
   * one. Its own function (`latestKeepSwitchAt` below, bound to `run` by
   * `runJob`) so a test can fake it without a database.
   */
  readonly getLatestKeepSwitchAt: (tenantId: string) => Promise<Date | null>;
  /**
   * The installation default's current generation, read afresh
   * (apps/worker/src/default-storage.ts). A cached entry that used an older
   * default is reloaded, the same way as one from before a "keep" switch: the
   * API refuses to move the default while tenants keep data on it, and this
   * closes the window in which a worker's cache still points at the old one.
   * Omitted (tests), the default is not checked.
   */
  readonly getDefaultGeneration?: () => Promise<string>;
}): Promise<StorageTargets> {
  const { tenantId, queue, storage, getLatestKeepSwitchAt, getDefaultGeneration } = options;
  if (STORAGE_WRITE_QUEUES.has(queue)) {
    const cached = storage.peek(tenantId);
    if (cached) {
      const resolved = cached as Partial<ResolvedTenantStorage>;
      const cachedGeneration = resolved.keepGeneration ?? null;
      const currentGeneration = await getLatestKeepSwitchAt(tenantId);
      const usedDefault = resolved.defaultGeneration ?? null;
      if (!sameGeneration(cachedGeneration, currentGeneration)) {
        storage.invalidate(tenantId);
      } else if (
        usedDefault !== null &&
        getDefaultGeneration &&
        usedDefault !== (await getDefaultGeneration())
      ) {
        storage.invalidate(tenantId);
      }
    }
  }
  return storage.get(tenantId);
}

/** What decides whether a checkpointed snapshot can still be resumed. */
export interface CheckpointOwner {
  /** `snapshots.manifest_path`: set once the snapshot is committed. */
  readonly manifestPath: string | null;
  /** Status of the job that wrote it; null when that job row is gone. */
  readonly jobStatus: JobStatus | null;
}

/**
 * Whether nothing can resume a checkpointed snapshot any more: its row is gone
 * (`null`) or committed, or the job that wrote it is gone or ended for good.
 * Only a queued or active job resumes from its cursor.
 */
export function isCheckpointAbandoned(owner: CheckpointOwner | null): boolean {
  if (!owner || owner.manifestPath !== null) {
    return true;
  }
  return owner.jobStatus === null || FINAL_JOB_STATUSES.includes(owner.jobStatus);
}

async function checkpointOwner(
  run: TenantTxRunner,
  tenantId: string,
  snapshotId: string,
): Promise<CheckpointOwner | null> {
  const [row] = await run((tx) =>
    tx
      .select({ manifestPath: snapshots.manifestPath, jobStatus: jobs.status })
      .from(snapshots)
      .leftJoin(jobs, and(eq(jobs.id, snapshots.jobId), eq(jobs.tenantId, snapshots.tenantId)))
      .where(and(eq(snapshots.tenantId, tenantId), eq(snapshots.id, snapshotId)))
      .limit(1),
  );
  return row ? { manifestPath: row.manifestPath, jobStatus: row.jobStatus ?? null } : null;
}

/**
 * Garbage collection's probe (core `AbandonedCheckpointProbe`): asked per
 * partial manifest, right when collection looks at it. A snapshot row exists
 * before its first checkpoint is written, so a running backup's checkpoint
 * always finds its active job here.
 */
export function abandonedCheckpointProbe(
  run: TenantTxRunner,
  tenantId: string,
): (snapshotId: string) => Promise<boolean> {
  return async (snapshotId) =>
    // Snapshot ids are uuids; a checkpoint named otherwise has no row at all.
    isCheckpointAbandoned(
      isUuid(snapshotId) ? await checkpointOwner(run, tenantId, snapshotId) : null,
    );
}

/** Which in-progress snapshots {@link discardAbandonedSnapshots} looks at. */
export type AbandonedSnapshotScope =
  /** The snapshots of one job that just ended for good. */
  | { readonly jobId: string; readonly protectedObjectId: string }
  /** Every in-progress snapshot of the tenant whose job ended for good or is gone. */
  | { readonly tenant: true };

/**
 * Discard in-progress snapshots nothing will resume: the partial manifest, a
 * final manifest a failed commit left, and the row (core
 * `discardUncommittedSnapshot`). Packs stay; garbage collection reclaims the
 * chunks no committed snapshot references. Best effort per snapshot: a
 * failure is logged and the next sweep tries again. Returns how many rows were
 * discarded.
 */
export async function discardAbandonedSnapshots(
  run: TenantTxRunner,
  env: { readonly tenantId: string; readonly storage: StorageTargets; readonly logger: Logger },
  scope: AbandonedSnapshotScope,
): Promise<number> {
  const inProgress = and(eq(snapshots.tenantId, env.tenantId), isNull(snapshots.manifestPath));
  const rows = await run(async (tx) => {
    if ("jobId" in scope) {
      return tx
        .select({ id: snapshots.id })
        .from(snapshots)
        .where(
          and(
            inProgress,
            eq(snapshots.protectedObjectId, scope.protectedObjectId),
            eq(snapshots.jobId, scope.jobId),
          ),
        );
    }
    return tx
      .select({ id: snapshots.id })
      .from(snapshots)
      .leftJoin(jobs, and(eq(jobs.id, snapshots.jobId), eq(jobs.tenantId, snapshots.tenantId)))
      .where(and(inProgress, or(isNull(jobs.id), inArray(jobs.status, [...FINAL_JOB_STATUSES]))));
  });
  if (rows.length === 0) {
    return 0;
  }
  const index = new PgSnapshotIndex(run, env.tenantId, env.logger);
  let discarded = 0;
  for (const { id } of rows) {
    try {
      const outcome = await discardUncommittedSnapshot({ ...env, snapshots: index }, id);
      if (outcome === "discarded") {
        discarded++;
      }
    } catch (error) {
      env.logger.warn("could not discard an abandoned snapshot", {
        snapshotId: id,
        ...errorFields(error),
      });
    }
  }
  if (discarded > 0) {
    env.logger.info("abandoned snapshots discarded", { count: discarded });
  }
  return discarded;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** GCM additional data a secret ciphertext is bound to (@restow/core secret-seal.ts). */
export { secretAad };

/**
 * Opens tenant secrets sealed by the API: base64 AES-256-GCM blobs under the
 * tenant DEK of the recorded key version, bound to the secret's own row id.
 */
export class PgSecretReader implements SecretReader {
  constructor(
    private readonly run: TenantTxRunner,
    private readonly tenantId: string,
    private readonly keys: TenantKeyring,
  ) {}

  async get(secretId: string): Promise<string | null> {
    if (!isUuid(secretId)) {
      return null;
    }
    const [row] = await this.run((tx) =>
      tx
        .select({ ciphertext: secrets.ciphertext })
        .from(secrets)
        .where(and(eq(secrets.tenantId, this.tenantId), eq(secrets.id, secretId)))
        .limit(1),
    );
    if (!row) {
      return null;
    }
    const sealed = Buffer.from(row.ciphertext, "base64");
    if (!sealedAad(sealed).equals(secretAad(secretId))) {
      throw new Error(`secret ${secretId} is bound to a different secret id`);
    }
    return this.keys.open(sealed).toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// Storage targets
// ---------------------------------------------------------------------------

function parseS3Credentials(raw: string, secretId: string): S3CredentialsSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`s3 credentials secret ${secretId} is not JSON`);
  }
  const value = parsed as Partial<S3CredentialsSecret> | null;
  if (
    !value ||
    typeof value.accessKeyId !== "string" ||
    typeof value.secretAccessKey !== "string"
  ) {
    throw new Error(`s3 credentials secret ${secretId} lacks accessKeyId/secretAccessKey`);
  }
  return {
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
    ...(typeof value.sessionToken === "string" ? { sessionToken: value.sessionToken } : {}),
  };
}

/** Build the backend for one `storage_targets` row. */
export async function storageBackendFor(
  target: StorageTarget,
  secretReader: SecretReader,
): Promise<StorageBackend> {
  if (target.kind === "local") {
    const config = target.config as { basePath?: unknown };
    if (typeof config.basePath !== "string" || config.basePath.length === 0) {
      throw new Error(`storage target ${target.id} has no basePath`);
    }
    return new LocalStorageBackend(config.basePath);
  }
  const config = target.config as {
    bucket?: unknown;
    prefix?: string;
    endpoint?: string;
    region?: string;
    forcePathStyle?: boolean;
  };
  if (typeof config.bucket !== "string" || config.bucket.length === 0) {
    throw new Error(`storage target ${target.id} has no bucket`);
  }
  let credentials: S3CredentialsSecret | undefined;
  if (target.secretRef) {
    const raw = await secretReader.get(target.secretRef);
    if (raw === null) {
      throw new Error(`storage target ${target.id} references a missing secret`);
    }
    credentials = parseS3Credentials(raw, target.secretRef);
  }
  return new S3StorageBackend({
    bucket: config.bucket,
    prefix: config.prefix,
    clientConfig: {
      endpoint: config.endpoint,
      region: config.region ?? "us-east-1",
      forcePathStyle: config.forcePathStyle ?? true,
      ...(credentials ? { credentials } : {}),
    },
  });
}

/**
 * {@link resolveTenantStorage}'s result: the ordinary `primary`/`copies` plus
 * `previous`, retired primaries a "keep" storage-target replacement left
 * behind (docs/STORAGE.md, "Replace the primary"; mirrors core's
 * `ResolvedStorageTargets`). Never folded into `copies`: nothing may ever
 * write to one. `runJob` wraps `primary` with these through
 * `withReadOnlyFallback` for the queues that are allowed to read them
 * (`READ_ONLY_FALLBACK_QUEUES`); every other reader of a cached
 * `StorageTargets` (this type's own callers included) sees the plain,
 * unwrapped primary.
 */
export interface ResolvedTenantStorage extends StorageTargets {
  readonly previous: readonly StorageBackend[];
  /**
   * The tenant's latest "keep" switch time this value was resolved against
   * (null if it never had one), read from the same transaction as the
   * `storage_targets` rows above. `resolveStorageForJob` compares this
   * against a freshly read current value to decide whether a cached entry
   * predates a switch — an equality check between two values that both come
   * from Postgres, never a comparison against the worker's own clock (see
   * that function for why: a wall-clock `loadedAt` stamped only once the
   * loader — which also runs `mirrorTenantKeys`, S3 round trips included —
   * has resolved cannot be trusted to order itself against `switchedAt`).
   */
  readonly keepGeneration: Date | null;
  /**
   * The generation of the installation default this value used (core
   * `installationDefaultGeneration`), or null when it used none: the tenant
   * has a primary row and no retired default attached. `resolveStorageForJob`
   * compares it with the current generation, read afresh, before a write-queue
   * job uses the cached value, so a default changed under Installation,
   * Default storage is never written to from a stale cache.
   */
  readonly defaultGeneration?: string | null;
}

/** The installation default as `resolveTenantStorage` takes it (apps/worker/src/default-storage.ts). */
export type TenantStorageDefaults =
  | StorageTargets
  | (() => Promise<{ readonly targets: StorageTargets; readonly generation: string }>);

/**
 * The tenant's storage targets from `storage_targets` (one primary, any number
 * of copies, plus any retired "previous" targets a "keep" replacement left
 * attached). A tenant without rows uses the installation default (saved under
 * Installation, Default storage, else the environment), which is how a fresh
 * Community install works out of the box.
 *
 * Same semantics as core `resolveStorageTargets`: without a primary row the
 * installation default is the primary (with its configured copy), and copy
 * rows always apply, so an offsite copy added to a tenant that still lives on
 * the installation default receives every new write. A `previous` row whose
 * `kind` is `installation_default` (the environment default itself, retired
 * by a "keep" switch away from it) opens the same way: to `defaults.primary`,
 * since such a row carries no addressing of its own.
 */
export async function resolveTenantStorage(options: {
  readonly run: TenantTxRunner;
  readonly tenantId: string;
  readonly secretReader: SecretReader;
  /** Fixed targets (tests), or the process's resolver of the current default, called only when needed. */
  readonly defaults: TenantStorageDefaults;
  readonly logger: Logger;
}): Promise<ResolvedTenantStorage> {
  // Both statements run inside the one transaction `run` opens, so the
  // `keepGeneration` stamped onto the result below is read alongside the
  // `storage_targets` rows it describes, not derived from a separate call
  // (and separate clock) minutes or milliseconds apart — see
  // `ResolvedTenantStorage.keepGeneration` and `resolveStorageForJob`.
  const { rows, keepGeneration } = await options.run(async (tx) => {
    const rows = await tx
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, options.tenantId))
      .orderBy(asc(storageTargets.createdAt));
    const keepGeneration = await latestKeepSwitchAtTx(tx, options.tenantId);
    return { rows, keepGeneration };
  });
  // Resolved once, and only when this tenant actually uses the default.
  const resolvedDefault: { used: { targets: StorageTargets; generation: string | null } | null } = {
    used: null,
  };
  const defaults = async (): Promise<StorageTargets> => {
    if (!resolvedDefault.used) {
      const source = options.defaults;
      resolvedDefault.used =
        typeof source === "function" ? await source() : { targets: source, generation: null };
    }
    return resolvedDefault.used.targets;
  };
  if (rows.length === 0) {
    const targets = await defaults();
    return {
      primary: targets.primary,
      copies: targets.copies,
      previous: [],
      keepGeneration,
      defaultGeneration: resolvedDefault.used?.generation ?? null,
    };
  }
  const primaryRow = rows.find((row) => row.role === "primary");
  const primary = primaryRow
    ? await storageBackendFor(primaryRow, options.secretReader)
    : (await defaults()).primary;
  const copies: StorageBackend[] = primaryRow ? [] : [...(await defaults()).copies];
  const previous: StorageBackend[] = [];
  for (const row of rows) {
    if (row.role === "copy") {
      copies.push(await storageBackendFor(row, options.secretReader));
    } else if (row.role === "previous") {
      previous.push(
        row.kind === "installation_default"
          ? (await defaults()).primary
          : await storageBackendFor(row, options.secretReader),
      );
    }
  }
  return {
    primary,
    copies,
    previous,
    keepGeneration,
    defaultGeneration: resolvedDefault.used?.generation ?? null,
  };
}

/** Generic per-tenant cache with a TTL (keyrings, storage targets). */
export class TenantCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly loader: (tenantId: string) => Promise<T>,
    private readonly ttlMs: number = KEYRING_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(tenantId: string): Promise<T> {
    const cached = this.entries.get(tenantId);
    if (cached && cached.expiresAt > this.clock()) {
      return cached.value;
    }
    const value = await this.loader(tenantId);
    this.entries.set(tenantId, { value, expiresAt: this.clock() + this.ttlMs });
    return value;
  }

  /**
   * The value currently cached for `tenantId`, regardless of whether its ttl
   * has already expired, or `undefined` when nothing is cached for it right
   * now. Lets a caller that knows about a change the cache cannot yet know
   * about (`resolveStorageForJob`'s "keep" switch check) compare a field
   * inside the cached value itself against a freshly read authority, without
   * forcing every read through a staleness check of its own and without
   * comparing this cache's own clock to anything (the exact mixing of clocks
   * `resolveStorageForJob` used to do through the now-removed `loadedAtOf`,
   * which stamped a value's age only once the loader — including, for
   * storage, `mirrorTenantKeys`'s S3 round trips — had already resolved).
   */
  peek(tenantId: string): T | undefined {
    return this.entries.get(tenantId)?.value;
  }

  invalidate(tenantId?: string): void {
    if (tenantId) {
      this.entries.delete(tenantId);
    } else {
      this.entries.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Tenant keyrings
// ---------------------------------------------------------------------------

/**
 * Load a tenant's DEKs, unwrapped through the key provider. Plaintext key
 * material lives only in memory, inside the returned keyring.
 */
export async function loadTenantKeyring(options: {
  readonly db: Database;
  readonly tenantId: string;
  readonly keyProvider: KeyProvider;
}): Promise<TenantKeyring> {
  const { db, tenantId, keyProvider } = options;
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ keyVersion: tenantKeys.keyVersion, encryptedDek: tenantKeys.encryptedDek })
      .from(tenantKeys)
      .where(eq(tenantKeys.tenantId, tenantId))
      .orderBy(asc(tenantKeys.keyVersion)),
  );
  if (rows.length === 0) {
    throw new Error(`tenant ${tenantId} has no data-encryption key`);
  }
  const deks = [];
  for (const row of rows) {
    deks.push(await keyProvider.unwrapDek(Buffer.from(row.encryptedDek, "base64")));
  }
  return new Keyring(tenantId, deks);
}

/**
 * Mirror the wrapped (never plaintext) DEKs into every storage target under
 * `tenants/<tid>/keys/<version>`, so the standalone restore can unwrap them
 * with the KEK alone (packages/cli). Idempotent. A mirror is compared byte
 * for byte with the database, not only checked for existence: a truncated or
 * damaged copy (an interrupted write, a bit flip) is rewritten, because the
 * standalone restore cannot open data encrypted under a key it cannot unwrap.
 */
export async function mirrorTenantKeys(options: {
  readonly run: TenantTxRunner;
  readonly tenantId: string;
  readonly storage: StorageTargets;
  readonly logger: Logger;
}): Promise<void> {
  const { run, tenantId, storage, logger } = options;
  const rows = await run((tx) =>
    tx
      .select({ keyVersion: tenantKeys.keyVersion, encryptedDek: tenantKeys.encryptedDek })
      .from(tenantKeys)
      .where(eq(tenantKeys.tenantId, tenantId)),
  );
  for (const row of rows) {
    const key = wrappedKeyKey(tenantId, row.keyVersion);
    const wrapped = Buffer.from(row.encryptedDek, "base64");
    for (const target of [storage.primary, ...storage.copies]) {
      const present = (await target.head(key)) !== null;
      if (present && (await storedBytesEqual(target, key, wrapped))) {
        continue;
      }
      await target.put(key, wrapped);
      if (present) {
        logger.warn("rewrote a damaged wrapped tenant key in storage", { key });
      } else {
        logger.info("mirrored wrapped tenant key to storage", { key });
      }
    }
  }
}

/** Whether `key` holds exactly `expected`; an object that cannot be read does not. */
async function storedBytesEqual(
  target: StorageBackend,
  key: string,
  expected: Buffer,
): Promise<boolean> {
  try {
    return (await target.get(key)).equals(expected);
  } catch {
    return false;
  }
}

/** Per-tenant keyring cache with a TTL, so a rotation is picked up without a restart. */
export type TenantKeyringCache = TenantCache<TenantKeyring>;

// ---------------------------------------------------------------------------
// Per-tenant concurrency
// ---------------------------------------------------------------------------

/**
 * Limits how many jobs run at once per tenant, so one tenant with many
 * mailboxes cannot monopolise the worker (and its Graph throttling budget).
 * Waiters are served in order; an aborted wait rejects with JobAbortedError.
 */
export class TenantConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("tenant concurrency limit must be a positive integer");
    }
  }

  activeCount(tenantId: string): number {
    return this.active.get(tenantId) ?? 0;
  }

  async acquire(tenantId: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new JobAbortedError();
    }
    if (this.activeCount(tenantId) < this.limit) {
      this.active.set(tenantId, this.activeCount(tenantId) + 1);
      return this.releaser(tenantId);
    }
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiting.get(tenantId) ?? [];
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = queue.indexOf(wake);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        reject(new JobAbortedError());
      };
      queue.push(wake);
      this.waiting.set(tenantId, queue);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.active.set(tenantId, this.activeCount(tenantId) + 1);
    return this.releaser(tenantId);
  }

  private releaser(tenantId: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = this.activeCount(tenantId) - 1;
      if (remaining <= 0) {
        this.active.delete(tenantId);
      } else {
        this.active.set(tenantId, remaining);
      }
      const next = this.waiting.get(tenantId)?.shift();
      if (next) {
        next();
      } else {
        this.waiting.delete(tenantId);
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Handlers and registry
// ---------------------------------------------------------------------------

/** What a handler may hand back; logged with the completion line. */
export interface JobOutcome {
  readonly summary?: LogFields;
}

/** The context a handler receives: the core JobContext over the worker's Database. */
export interface WorkerJobContext extends JobContext<Database> {
  /** Loaded when the payload names a protected object; null otherwise. */
  readonly protectedObject: ProtectedObjectRef | null;
}

export interface JobHandler<Q extends QueueName = QueueName> {
  readonly queue: Q;
  /** Parallel jobs for this queue in one worker process (default from WORKER_CONCURRENCY). */
  readonly concurrency?: number;
  // biome-ignore lint/suspicious/noConfusingVoidType: a handler without a summary simply returns
  run(ctx: WorkerJobContext, payload: JobPayloads[Q]): Promise<JobOutcome | void>;
}

/** A handler for any queue (the union keeps payload and queue types paired). */
export type AnyJobHandler = { [Q in QueueName]: JobHandler<Q> }[QueueName];

/** One handler per queue; registering a queue twice is a programming error. */
export class HandlerRegistry {
  private readonly handlers = new Map<QueueName, AnyJobHandler>();

  constructor(handlers: readonly AnyJobHandler[] = []) {
    for (const handler of handlers) {
      this.register(handler);
    }
  }

  register(handler: AnyJobHandler): void {
    if (this.handlers.has(handler.queue)) {
      throw new Error(`queue ${handler.queue} already has a handler`);
    }
    this.handlers.set(handler.queue, handler);
  }

  get(queue: QueueName): AnyJobHandler | undefined {
    return this.handlers.get(queue);
  }

  list(): AnyJobHandler[] {
    return [...this.handlers.values()];
  }

  queues(): QueueName[] {
    return [...this.handlers.keys()];
  }
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

export class InvalidPayloadError extends Error {
  /**
   * What an operator has to fix, when the rejection has a known cause (the
   * source is not connected, an account has no password): the job stores it
   * instead of the generic "a setting prevents this job".
   */
  readonly failure: FailureCause | undefined;

  constructor(message: string, failure?: FailureCause) {
    super(message);
    this.name = "InvalidPayloadError";
    this.failure = failure;
  }
}

/** Check the fields every payload must carry; queue-specific fields are the handler's business. */
export function parseJobPayload<Q extends QueueName>(queue: Q, data: unknown): JobPayloads[Q] {
  if (!data || typeof data !== "object") {
    throw new InvalidPayloadError(`${queue} job has no payload`);
  }
  const record = data as Record<string, unknown>;
  if (!isUuid(record.jobId)) {
    throw new InvalidPayloadError(`${queue} job payload has no jobId`);
  }
  if (!isUuid(record.tenantId)) {
    throw new InvalidPayloadError(`${queue} job payload has no tenantId`);
  }
  if (record.protectedObjectId !== undefined && !isUuid(record.protectedObjectId)) {
    throw new InvalidPayloadError(`${queue} job payload has an invalid protectedObjectId`);
  }
  return record as unknown as JobPayloads[Q];
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

/**
 * Why a job's abort signal fired: the process is shutting down, the API
 * cancelled it, or the pg-boss expiration is about to hit. Shutdown and expiry
 * both mean "checkpoint now, continue in the retry".
 */
export type AbortReason = "shutdown" | "cancelled" | "expired";

export function abortReasonOf(signal: AbortSignal): AbortReason | null {
  if (!signal.aborted) {
    return null;
  }
  if (signal.reason === "cancelled" || signal.reason === "expired") {
    return signal.reason;
  }
  return "shutdown";
}

/** Abort this fraction into the pg-boss expiration so the handler returns before pg-boss fails it. */
export const EXPIRY_ABORT_FRACTION = 0.95;

export function expiryAbortDelayMs(expireInSeconds: number): number | null {
  if (!Number.isFinite(expireInSeconds) || expireInSeconds <= 0) {
    return null;
  }
  return Math.floor(expireInSeconds * 1000 * EXPIRY_ABORT_FRACTION);
}

/** The `jobs.status` to record when a run ends in an error, given pg-boss' retry budget. */
export function statusAfterFailure(retryCount: number, retryLimit: number): JobStatus {
  return retryCount < retryLimit ? "queued" : "failed";
}

export async function loadProtectedObject(
  run: TenantTxRunner,
  tenantId: string,
  protectedObjectId: string,
): Promise<ProtectedObjectRef | null> {
  const [row] = await run((tx) =>
    tx
      .select()
      .from(protectedObjects)
      .where(
        and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, protectedObjectId)),
      )
      .limit(1),
  );
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    sourceId: row.sourceId,
    kind: row.kind,
    externalId: row.externalId,
    displayName: row.displayName,
    userId: row.userId,
  };
}

/**
 * Make sure the lifecycle row exists and mark it active. The scheduler and the
 * API insert the row before enqueuing; the upsert covers the race where the
 * queue delivers first, and keeps the first `started_at` across retries.
 */
async function markJobActive(
  run: TenantTxRunner,
  payload: JobPayload,
  queue: QueueName,
  pgBossJobId: string,
  now: Date,
  protectedObjectId: string | null,
): Promise<void> {
  await run(async (tx) => {
    await tx
      .insert(jobs)
      .values({
        id: payload.jobId,
        tenantId: payload.tenantId,
        queue,
        status: "active",
        protectedObjectId,
        payload: payload as unknown as Record<string, unknown>,
        pgBossJobId,
        startedAt: now,
      })
      .onConflictDoUpdate({
        target: jobs.id,
        set: {
          status: "active",
          pgBossJobId,
          startedAt: sql`coalesce(${jobs.startedAt}, ${now})`,
        },
      });
  });
}

function protectedObjectIdOf(payload: JobPayload): string | null {
  const id = (payload as { protectedObjectId?: unknown }).protectedObjectId;
  return isUuid(id) ? id : null;
}

/** A job row as it stands after the runner recorded its outcome. */
export type FinishedJob = Pick<
  Job,
  | "id"
  | "queue"
  | "status"
  | "protectedObjectId"
  | "startedAt"
  | "completedAt"
  | "errorMessage"
  | "failure"
>;

async function finishJob(
  run: TenantTxRunner,
  jobId: string,
  status: JobStatus,
  now: Date,
  errorMessage: string | null = null,
  failure: FailureRecordJson | null = null,
): Promise<FinishedJob | null> {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  const [row] = await run((tx) =>
    tx
      .update(jobs)
      .set({
        status,
        completedAt: terminal ? now : null,
        errorMessage,
        failure,
        // A finished or dead job has nothing to resume; a retry keeps its cursor.
        ...(terminal ? { cursor: null } : {}),
      })
      .where(eq(jobs.id, jobId))
      .returning({
        id: jobs.id,
        queue: jobs.queue,
        status: jobs.status,
        protectedObjectId: jobs.protectedObjectId,
        startedAt: jobs.startedAt,
        completedAt: jobs.completedAt,
        errorMessage: jobs.errorMessage,
        failure: jobs.failure,
      }),
  );
  return row ?? null;
}

async function currentStatus(run: TenantTxRunner, jobId: string): Promise<JobStatus | null> {
  const [row] = await run((tx) =>
    tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1),
  );
  return row?.status ?? null;
}

export interface ProgressSettings {
  readonly flushEveryItems: number;
  readonly flushIntervalMs: number;
}

/** Everything the runner needs from the process. Built once in index.ts. */
export interface WorkerRuntime {
  readonly db: Database;
  /**
   * The environment's installation-default targets as read at start-up (the
   * start-up log, tests). Tenants resolve the default that applies right now
   * (saved under Installation, Default storage, else this one) through the
   * `storage` cache's loader (index.ts, default-storage.ts).
   */
  readonly defaultStorage: StorageTargets;
  /** The current installation default's generation, read afresh (see `resolveStorageForJob`). */
  readonly defaultStorageGeneration?: () => Promise<string>;
  readonly keyrings: TenantKeyringCache;
  readonly storage: TenantCache<StorageTargets>;
  readonly logger: Logger;
  readonly tenantLimiter: TenantConcurrencyLimiter;
  /** Fires when the process is shutting down. */
  readonly shutdownSignal: AbortSignal;
  readonly now: () => Date;
  /** How often to check whether the API cancelled the running job. */
  readonly cancelPollMs: number;
  readonly progress: ProgressSettings;
  /**
   * Called once a job reached its final status (completed, failed for good,
   * or cancelled), e.g. to raise the `job.completed` / `job.failed` webhooks.
   * A failing hook is logged and never changes the job's outcome.
   */
  readonly onJobFinished?: (tenantId: string, job: FinishedJob) => Promise<unknown>;
}

// A failed query's own message carries the SQL and the bound parameters; logs
// and the job row get the driver error behind it (@restow/db reportableError).
function errorFields(failure: unknown): LogFields {
  const error = reportableError(failure);
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorMessage: String(error) };
}

/**
 * Truncate an error message for the `jobs.error_message` column (never a
 * stack, never a payload) and take secrets out of it: tokens, credentials in
 * `key=value` pairs, query strings, key material.
 */
function errorMessageOf(failure: unknown): string {
  const error = reportableError(failure);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSensitiveText(message, 2000);
}

/**
 * Run one delivered pg-boss job through a handler. Resolves when pg-boss may
 * complete the job; throws when pg-boss must fail it (and retry if budget
 * remains). A cancelled or rejected job resolves: the lifecycle row is the
 * truth for the UI and a retry would be wrong.
 */
export async function runJob(
  runtime: WorkerRuntime,
  handler: AnyJobHandler,
  job: PgBoss.JobWithMetadata<unknown>,
): Promise<void> {
  const queue = handler.queue;
  const payload = parseJobPayload(queue, job.data);
  const logger = runtime.logger.child({
    jobId: payload.jobId,
    tenantId: payload.tenantId,
    queue,
    pgBossJobId: job.id,
    attempt: job.retryCount,
  });
  const release = await runtime.tenantLimiter.acquire(payload.tenantId, runtime.shutdownSignal);
  const run = tenantRunner(runtime.db, payload.tenantId);
  const controller = new AbortController();
  const onShutdown = () => controller.abort("shutdown");
  runtime.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  let cancelPoll: ReturnType<typeof setInterval> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let reporter: ReturnType<typeof createProgressReporter>["reporter"] | null = null;

  const expiryDelay = expiryAbortDelayMs(job.expireInSeconds);
  if (expiryDelay !== null) {
    expiryTimer = setTimeout(() => controller.abort("expired"), expiryDelay);
    expiryTimer.unref();
  }

  /**
   * Drop the snapshots this job left in progress once it can never resume
   * them (see {@link discardAbandonedSnapshots}). Never changes the outcome.
   */
  const discardOwnSnapshots = async (protectedObjectId: string | null): Promise<void> => {
    if (!SNAPSHOT_QUEUES.has(queue) || !protectedObjectId) {
      return;
    }
    try {
      const storage = await runtime.storage.get(payload.tenantId);
      await discardAbandonedSnapshots(
        run,
        { tenantId: payload.tenantId, storage, logger },
        { jobId: payload.jobId, protectedObjectId },
      );
    } catch (cleanupError) {
      logger.warn("could not discard the snapshots this job left in progress", {
        ...errorFields(cleanupError),
      });
    }
  };

  /**
   * Record the outcome. A final one clears the job's own leftover snapshots
   * and is announced to the runtime's hook.
   */
  const finish = async (
    status: JobStatus,
    errorMessage?: string,
    failure?: FailureRecordJson,
  ): Promise<void> => {
    const row = await finishJob(
      run,
      payload.jobId,
      status,
      runtime.now(),
      errorMessage,
      failure ?? null,
    );
    if (!row?.completedAt) {
      return;
    }
    await discardOwnSnapshots(row.protectedObjectId);
    if (!runtime.onJobFinished) {
      return;
    }
    try {
      await runtime.onJobFinished(payload.tenantId, row);
    } catch (hookError) {
      logger.warn("job-finished hook failed", errorFields(hookError));
    }
  };

  // The object the job works on, once loaded: a failure that concerns its whole
  // source (consent revoked, wrong password) is recorded on the source too.
  let workingObject: ProtectedObjectRef | null = null;

  /** Mark the source broken with the classified cause (only a source that is in use). */
  const markSourceFailure = async (failure: FailureRecordJson, message: string): Promise<void> => {
    if (!workingObject) {
      return;
    }
    try {
      await run((tx) =>
        tx
          .update(sources)
          .set({ status: "error", errorMessage: message, failure })
          .where(
            and(
              eq(sources.tenantId, payload.tenantId),
              eq(sources.id, (workingObject as ProtectedObjectRef).sourceId),
              inArray(sources.status, ["active", "error"]),
            ),
          ),
      );
    } catch (sourceError) {
      logger.warn("could not record the failure on the source", errorFields(sourceError));
    }
  };

  /**
   * A job that worked proves the source connection again: clear the error a
   * job recorded (never one a directory sync recorded, which a backup says
   * nothing about).
   */
  const clearSourceFailure = async (): Promise<void> => {
    if (!workingObject || queue === "directory") {
      return;
    }
    try {
      await run((tx) =>
        tx
          .update(sources)
          .set({ status: "active", errorMessage: null, failure: null })
          .where(
            and(
              eq(sources.tenantId, payload.tenantId),
              eq(sources.id, (workingObject as ProtectedObjectRef).sourceId),
              eq(sources.status, "error"),
              sql`${sources.failure} IS NOT NULL`,
              sql`coalesce(${sources.failure}->'params'->>'queue', '') <> 'directory'`,
            ),
          ),
      );
    } catch (sourceError) {
      logger.warn("could not clear the failure on the source", errorFields(sourceError));
    }
  };

  try {
    if ((await currentStatus(run, payload.jobId)) === "cancelled") {
      logger.info("job was cancelled before it started");
      // Cancelled while waiting for a retry: the earlier attempt's checkpoint
      // is never resumed now.
      await discardOwnSnapshots(protectedObjectIdOf(payload));
      return;
    }
    const protectedObjectId = protectedObjectIdOf(payload);
    const protectedObject = protectedObjectId
      ? await loadProtectedObject(run, payload.tenantId, protectedObjectId)
      : null;
    // The row references the object only when it exists (foreign key); a job
    // for a vanished object is still recorded, as failed, right below.
    workingObject = protectedObject;
    await markJobActive(run, payload, queue, job.id, runtime.now(), protectedObject?.id ?? null);
    logger.info("job started");
    if (protectedObjectId && !protectedObject) {
      throw new InvalidPayloadError(`protected object ${protectedObjectId} does not exist`);
    }

    const keys = await runtime.keyrings.get(payload.tenantId);
    const secretReader = new PgSecretReader(run, payload.tenantId, keys);
    const storage = storageForQueue(
      await resolveStorageForJob({
        tenantId: payload.tenantId,
        queue,
        storage: runtime.storage,
        getLatestKeepSwitchAt: (tenantId) => latestKeepSwitchAt(run, tenantId),
        getDefaultGeneration: runtime.defaultStorageGeneration,
      }),
      queue,
    );

    const progress = createProgressReporter({
      run,
      tenantId: payload.tenantId,
      jobId: payload.jobId,
      protectedObjectId,
      logger,
      now: runtime.now,
      flushEveryItems: runtime.progress.flushEveryItems,
      flushIntervalMs: runtime.progress.flushIntervalMs,
      onCancelRequested: () => controller.abort("cancelled"),
    });
    reporter = progress.reporter;
    await progress.sink.ensureRow();

    cancelPoll = setInterval(() => {
      void currentStatus(run, payload.jobId)
        .then((status) => {
          if (status === "cancelled") {
            controller.abort("cancelled");
          }
        })
        .catch((error: unknown) => logger.debug("cancel probe failed", errorFields(error)));
    }, runtime.cancelPollMs);
    cancelPoll.unref();

    const ctx: WorkerJobContext = {
      jobId: payload.jobId,
      tenantId: payload.tenantId,
      queue,
      attempt: job.retryCount,
      db: runtime.db,
      storage,
      keys,
      secrets: secretReader,
      chunkIndex: new PgChunkIndex(run, payload.tenantId),
      snapshots: new PgSnapshotIndex(run, payload.tenantId, logger),
      progress: progress.reporter,
      cursor: new PgCursorStore(run, payload.jobId),
      logger,
      signal: controller.signal,
      now: runtime.now,
      protectedObject,
    };

    // The union of handlers is dispatched by queue; the payload was parsed for that queue.
    const outcome = await (handler as JobHandler).run(ctx, payload as never);
    await progress.reporter.flush();
    await finish("completed");
    await clearSourceFailure();
    logger.info("job completed", { ...outcome?.summary, progress: progress.reporter.snapshot() });
  } catch (error) {
    const snapshot = reporter?.snapshot() ?? null;
    await reporter?.flush().catch((flushError: unknown) => {
      logger.warn("final progress flush failed", errorFields(flushError));
    });
    const reason = abortReasonOf(controller.signal);
    if (reason === "cancelled") {
      await finish("cancelled");
      logger.info("job cancelled", { progress: snapshot });
      return;
    }
    const failedAt = runtime.now();
    if (error instanceof InvalidPayloadError) {
      const failure = jobFailureRecord({
        error,
        now: failedAt,
        step: snapshot?.phase ?? null,
        abortReason: null,
        retry: null,
        queue,
      });
      await finish("failed", errorMessageOf(error), failure);
      if (isSourceScopedCause(failure)) {
        await markSourceFailure(failure, errorMessageOf(error));
      }
      logger.error("job rejected", errorFields(error));
      return;
    }
    const status = statusAfterFailure(job.retryCount, job.retryLimit);
    const failure = jobFailureRecord({
      error,
      now: failedAt,
      step: snapshot?.phase ?? null,
      abortReason: reason ?? null,
      retry: status === "queued" ? retryStateOf(job, failedAt) : null,
      queue,
    });
    await finish(status, errorMessageOf(error), failure);
    if (isSourceScopedCause(failure)) {
      await markSourceFailure(failure, errorMessageOf(error));
    }
    if (reason === "shutdown" || reason === "expired") {
      logger.warn("job interrupted, continuing in the retry", {
        reason,
        status,
        progress: snapshot,
      });
    } else {
      logger.error("job failed", { ...errorFields(error), status, progress: snapshot });
    }
    throw error;
  } finally {
    if (cancelPoll) {
      clearInterval(cancelPoll);
    }
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    runtime.shutdownSignal.removeEventListener("abort", onShutdown);
    release();
  }
}

/** The pg-boss work callback for a handler (batchSize 1, metadata included). */
export function createWorkHandler(
  runtime: WorkerRuntime,
  handler: AnyJobHandler,
): PgBoss.WorkWithMetadataHandler<unknown> {
  return async (delivered) => {
    for (const job of delivered) {
      await runJob(runtime, handler, job);
    }
  };
}
