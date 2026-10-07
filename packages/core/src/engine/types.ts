/**
 * Engine contracts: the seam between the storage format (@restow/core) and the
 * job runtime (apps/worker).
 *
 * A backup, restore or verify engine never talks to Postgres, pg-boss or the
 * environment directly. Everything it needs arrives in a {@link JobContext}:
 * storage targets, the tenant keyring, the chunk/snapshot indexes, progress and
 * cursor persistence, a logger and a cancellation signal. The worker builds the
 * context from Postgres; tests build it from the in-memory implementations in
 * ./memory.ts. This keeps the engines pure enough to test with fixtures only
 * (docs/TESTING.md) and keeps the storage format independent of the database.
 */
import type { Dek } from "../crypto.js";
import type { FailureCause } from "../failures/types.js";
import type { ManifestObject } from "../manifest.js";
import type { StorageBackend } from "../storage/backend.js";

// ---------------------------------------------------------------------------
// Job vocabulary (mirrors the enums in @restow/db; keep in lock-step).
// ---------------------------------------------------------------------------

/** What a protected object is: an Exchange mailbox, a OneDrive, or an IMAP account. */
export type ProtectedObjectKind = "mailbox" | "onedrive" | "imap";

/** The pg-boss queues (docs/ARCHITECTURE.md, Job-System). */
export type JobQueue =
  | "backup"
  | "restore"
  | "verify"
  | "archive"
  | "directory"
  | "retention"
  | "scrub"
  | "storage_migration"
  | "import"
  | "export";

/** Where a snapshot's data came from (mirrors ManifestSource.type). */
export type SourceKind = "m365" | "imap";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogFields = Record<string, unknown>;

/**
 * Structured logger. Implementations emit one JSON object per line and never
 * receive secrets: callers pass identifiers and counts, not tokens or payloads.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line it emits. */
  child(fields: LogFields): Logger;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** A point-in-time view of a job's progress counters. */
export interface ProgressSnapshot {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  /** Payload bytes the engine reported as stored (new data) with `advance(done, bytes)`. */
  readonly bytes: number;
  /**
   * Bytes the engine read and handled (the third argument of `advance`, `bytes` where an engine
   * gives none): the run drawer's "processed" curve. Absent in snapshots built before it existed.
   */
  readonly bytesProcessed?: number;
  /** Bytes written to the repository as packs (compressed and sealed): what the run transferred. */
  readonly bytesTransferred?: number;
  readonly phase: string | null;
  /** Estimated seconds to completion, or null when unknown. */
  readonly etaSeconds: number | null;
}

/** An item a job could not process; persisted as an `item_failures` row. */
export interface ItemFailureRecord {
  /** Item id or path within the source. */
  readonly itemRef: string;
  readonly reason: string;
  /**
   * The classified cause (packages/core/src/failures), stored next to the
   * reason so the UI can say why and what to do. Absent for engines that only
   * have text; the reason always stays.
   */
  readonly cause?: FailureCause;
  /**
   * When the item itself is dated (a message's received time), ISO 8601. Lets the operator find
   * the item at the source; absent where the engine does not know it.
   */
  readonly itemDate?: string;
}

/** What else an engine knows about an item that failed. */
export interface ItemFailureDetails {
  /** The item's own date (a message's received time), ISO 8601. */
  readonly itemDate?: string | null;
}

/**
 * Progress reporting for the UI (job_progress, streamed over SSE). Methods are
 * synchronous and cheap; persistence happens in batches behind the scenes.
 * `flush()` forces the pending state out (the framework calls it at the end).
 */
export interface ProgressReporter {
  /** Set (or raise) the expected number of items. May be called repeatedly as discovery proceeds. */
  total(count: number): void;
  /**
   * Record `done` more items (default 1) and `bytes` more payload bytes (default 0). `processed`
   * is how many bytes the engine read for them, which can exceed `bytes` when most of it was
   * already stored (deduplication); it defaults to `bytes`.
   */
  advance(done?: number, bytes?: number, processed?: number): void;
  /**
   * Record `bytes` more written to the repository (a pack the chunk store uploaded). Optional so
   * reporters of tests and engines that never upload need not implement it.
   */
  transfer?(bytes: number): void;
  /**
   * Record an item that failed, with a human-readable reason (no secrets) and,
   * where the engine has the error at hand, its classified cause.
   */
  fail(itemRef: string, reason: string, cause?: FailureCause, details?: ItemFailureDetails): void;
  /** Name the current phase, e.g. "enumerate", "download", "manifest". */
  phase(name: string): void;
  /** Current counters. */
  snapshot(): ProgressSnapshot;
  /** Persist whatever is pending. */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cursor (resume on restart)
// ---------------------------------------------------------------------------

/**
 * Snapshot-writer checkpoint, stored inside the cursor so a restarted job can
 * pick up the manifest it was assembling (see SnapshotWriter.checkpoint()).
 */
export interface SnapshotCheckpoint {
  readonly snapshotId: string;
  readonly sequence: number;
  /** Storage key of the partial manifest written at checkpoint time. */
  readonly partialKey: string;
  /** Number of objects in the partial manifest, for logging and sanity checks. */
  readonly objectCount: number;
}

/**
 * Resumable position of a job. The known fields mirror the `jobs.cursor` jsonb
 * type in @restow/db; engines may add their own keys (the index signature) as
 * long as the value stays JSON-serialisable and free of secrets.
 */
export interface Cursor {
  /** Folder currently being processed (mailbox folder id, drive folder id, IMAP mailbox). */
  folderId?: string;
  /** The delta token / delta link currently in use for `folderId`. */
  deltaToken?: string;
  /** Last item id fully processed within the current folder/page. */
  lastItemId?: string;
  /** Page number within a paged enumeration. */
  page?: number;
  /** Per-folder delta links (docs/MICROSOFT.md, per-folder delta tokens). */
  deltaTokens?: Record<string, string>;
  /** The snapshot being assembled by this job, if it has checkpointed. */
  snapshot?: SnapshotCheckpoint;
  [key: string]: unknown;
}

/** Persistence for a job's {@link Cursor} (jobs.cursor). */
export interface CursorStore {
  load(): Promise<Cursor | null>;
  save(cursor: Cursor): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Keys and storage
// ---------------------------------------------------------------------------

/**
 * A tenant's data-encryption keys. New chunks are sealed with `current`; older
 * versions stay available so chunks from before a rotation remain readable.
 * `chunkIdKey` is the stable HMAC key for stored ids (see ./keyring.ts).
 */
export interface TenantKeyring {
  readonly tenantId: string;
  /** The newest key version, used to seal new chunks. */
  readonly current: Dek;
  /** Stable per-tenant HMAC key for chunk stored ids (never changes on rotation). */
  readonly chunkIdKey: Buffer;
  /** All key versions held, ascending. */
  versions(): number[];
  byVersion(version: number): Dek | undefined;
  /** Open a sealed chunk with the key version its header names. */
  open(sealed: Buffer): Buffer;
}

/** The primary storage target and any copy targets (docs/ARCHITECTURE.md). */
export interface StorageTargets {
  readonly primary: StorageBackend;
  /** Additional targets every pack and manifest is also written to. */
  readonly copies: readonly StorageBackend[];
}

/**
 * Read access to the tenant's encrypted secret store (`secrets` rows referenced
 * by `secret_ref` columns: IMAP passwords, Entra client secrets, OAuth refresh
 * tokens, S3 credentials). Plaintext is returned to the caller only; it is never
 * logged or persisted by the framework.
 */
export interface SecretReader {
  /** The decrypted secret, or null when no row with that id exists for the tenant. */
  get(secretId: string): Promise<string | null>;
}

/** Plaintext layout of an `s3_credentials` secret (JSON). */
export interface S3CredentialsSecret {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

// ---------------------------------------------------------------------------
// Chunk index (Postgres mirror of what the packs contain)
// ---------------------------------------------------------------------------

/** A finalized pack file in storage (`packs` row). */
export interface PackRecord {
  readonly id: string;
  /** Storage key, e.g. `tenants/<tid>/packs/ab/<packid>`. */
  readonly path: string;
  /** SHA-256 (hex) over the complete pack file, for the scrub job. */
  readonly sha256: string;
  readonly size: number;
}

/** One chunk inside a pack (`chunks` row). Lengths and offsets refer to the sealed bytes. */
export interface ChunkRecord {
  /** Stored id as lowercase hex. */
  readonly storedId: string;
  readonly offset: number;
  readonly length: number;
}

/** Where a chunk lives. */
export interface ChunkLocation extends ChunkRecord {
  readonly packPath: string;
}

/**
 * The tenant-scoped chunk index. Implemented against Postgres by the worker and
 * in memory for tests. All ids are lowercase hex.
 *
 * A pack the scrub found damaged on every storage target is marked damaged.
 * Its chunks no longer count as stored for deduplication, so the next backup
 * that meets the same content writes an intact copy, and recording that copy
 * moves the chunk's row to the new pack. Reads keep finding every chunk.
 */
export interface ChunkIndex {
  /** Which of `storedIds` exist for this tenant in a pack that is not marked damaged. */
  existing(storedIds: readonly string[]): Promise<Set<string>>;
  /**
   * Record a pack that has been fully written to every storage target, with
   * its chunks. A chunk already recorded in another intact pack keeps its row
   * (first row wins); one recorded in a damaged pack is moved to this pack.
   */
  recordPack(pack: PackRecord, chunks: readonly ChunkRecord[]): Promise<void>;
  /** Locate chunks by stored id. Missing ids are simply absent from the result. */
  locate(storedIds: readonly string[]): Promise<Map<string, ChunkLocation>>;
  /** Increment refcounts: one per occurrence in `storedIds`. */
  addReferences(storedIds: readonly string[]): Promise<void>;
  /** Decrement refcounts: one per occurrence in `storedIds`. Never below zero. */
  releaseReferences(storedIds: readonly string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Snapshot index (Postgres mirror of the manifests)
// ---------------------------------------------------------------------------

export type SnapshotStatus = "active" | "pruned";

/** A `snapshots` row. `manifestPath` is null while a snapshot is in progress or was abandoned. */
export interface SnapshotRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly protectedObjectId: string;
  readonly jobId: string | null;
  readonly sequence: number;
  readonly manifestPath: string | null;
  readonly status: SnapshotStatus;
  readonly itemCount: number;
  readonly byteSize: number;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface NewSnapshotRecord {
  readonly id: string;
  readonly protectedObjectId: string;
  readonly jobId: string | null;
  readonly sequence: number;
  readonly startedAt: Date;
}

export interface CompleteSnapshotInput {
  readonly manifestPath: string;
  readonly itemCount: number;
  readonly byteSize: number;
  readonly completedAt: Date;
}

export interface SnapshotIndex {
  /** The newest completed (manifestPath set, status active) snapshot of a protected object. */
  latestCompleted(protectedObjectId: string): Promise<SnapshotRecord | null>;
  get(snapshotId: string): Promise<SnapshotRecord | null>;
  /** The next free sequence number for a protected object (1 for the first snapshot). */
  nextSequence(protectedObjectId: string): Promise<number>;
  /** Insert an in-progress snapshot row. */
  create(input: NewSnapshotRecord): Promise<SnapshotRecord>;
  /** Mark a snapshot complete: manifest written, counts final. */
  complete(snapshotId: string, input: CompleteSnapshotInput): Promise<void>;
  /**
   * Mirror the manifest's object list for search and the restore explorer.
   * Implementations without an object table may no-op; the manifest in storage
   * remains the source of truth (docs/ARCHITECTURE.md).
   */
  recordObjects(snapshotId: string, objects: readonly ManifestObject[]): Promise<void>;
  /** Delete an abandoned in-progress snapshot row (no manifest was ever committed). */
  discard(snapshotId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Job context
// ---------------------------------------------------------------------------

/**
 * Everything a job needs, assembled by the worker per job. `Db` is the
 * database handle type of the host (the worker passes its Drizzle `Database`);
 * core never depends on it, so engines that need raw queries narrow it
 * themselves.
 */
export interface JobContext<Db = unknown> {
  readonly jobId: string;
  readonly tenantId: string;
  readonly queue: JobQueue;
  /** 0 for the first run, incremented on every pg-boss retry. */
  readonly attempt: number;
  readonly db: Db;
  /** The tenant's storage targets (from `storage_targets`, or the installation defaults). */
  readonly storage: StorageTargets;
  readonly keys: TenantKeyring;
  readonly secrets: SecretReader;
  readonly chunkIndex: ChunkIndex;
  readonly snapshots: SnapshotIndex;
  readonly progress: ProgressReporter;
  readonly cursor: CursorStore;
  readonly logger: Logger;
  /** Aborted on cancellation and on worker shutdown; engines checkpoint and return promptly. */
  readonly signal: AbortSignal;
  /** Injectable clock (tests pin it). */
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/** A `protected_objects` row as an engine sees it. */
export interface ProtectedObjectRef {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly kind: ProtectedObjectKind;
  /** Mailbox address, drive id or IMAP login. */
  readonly externalId: string;
  readonly displayName: string | null;
  readonly userId: string | null;
}

export interface BackupOptions {
  /** Ignore delta state and re-enumerate everything (dedup keeps storage cheap). */
  readonly full?: boolean;
}

export interface BackupResult {
  readonly snapshotId: string;
  readonly sequence: number;
  /** Objects newly written or changed in this run. */
  readonly objectsWritten: number;
  /** Objects in the committed manifest (written plus carried forward). */
  readonly objectsTotal: number;
  /** New plaintext bytes stored in this run (after dedup). */
  readonly bytes: number;
  readonly failures: readonly ItemFailureRecord[];
}

export interface BackupEngine<Db = unknown> {
  readonly kind: ProtectedObjectKind;
  run(
    ctx: JobContext<Db>,
    protectedObject: ProtectedObjectRef,
    options: BackupOptions,
  ): Promise<BackupResult>;
}

export type RestoreTargetType = "original" | "other" | "download";
export type RestoreMode = "rename" | "replace" | "skip";

/** Which objects of a snapshot to restore (empty selection = everything). */
export interface RestoreSelection {
  /** Restore the whole snapshot. */
  readonly all?: boolean;
  /** Exact object paths. */
  readonly paths?: readonly string[];
  /** Folder prefixes; every object below is restored. */
  readonly folderPaths?: readonly string[];
  /** Source item ids (ManifestObject.id). */
  readonly objectIds?: readonly string[];
}

export interface RestoreTarget {
  readonly type: RestoreTargetType;
  /** Target mailbox address / drive id / path; null for a download restore. */
  readonly ref: string | null;
}

export interface RestoreActor {
  readonly userId: string | null;
  readonly impersonated: boolean;
  readonly reason: string | null;
}

export interface RestoreRequest {
  readonly restoreJobId: string;
  readonly snapshotId: string;
  readonly protectedObject: ProtectedObjectRef;
  readonly selection: RestoreSelection;
  readonly target: RestoreTarget;
  readonly mode: RestoreMode;
  readonly actor: RestoreActor;
  /**
   * When the restore was requested (`restore_jobs.created_at`). Names derived
   * from a time, such as the default restore folder, are taken from it, so
   * every attempt of a retried job arrives at the same one. Callers without a
   * stored request (verify probes) omit it; the job clock is used instead.
   */
  readonly requestedAt?: Date;
}

export interface RestoreResult {
  readonly restored: number;
  readonly skipped: number;
  readonly bytes: number;
  readonly failures: readonly ItemFailureRecord[];
  /** For download restores: the storage key of the produced archive. */
  readonly downloadKey?: string | null;
}

export interface RestoreEngine<Db = unknown> {
  readonly kind: ProtectedObjectKind;
  run(ctx: JobContext<Db>, request: RestoreRequest): Promise<RestoreResult>;
}

export type VerifyKind = "verify" | "health_check";
export type RecoveryReadiness = "green" | "yellow" | "red";

export interface VerifyOptions {
  readonly kind: VerifyKind;
  /** How many objects to sample for a `verify` run (docs/TESTING.md: 20 mails + 20 files). */
  readonly sampleSize: number;
}

export interface VerifyResult {
  readonly readiness: RecoveryReadiness;
  readonly checked: number;
  readonly mismatched: number;
  readonly missing: number;
  readonly details: Record<string, unknown>;
}

export interface VerifyEngine<Db = unknown> {
  readonly kind: ProtectedObjectKind;
  run(
    ctx: JobContext<Db>,
    protectedObject: ProtectedObjectRef,
    options: VerifyOptions,
  ): Promise<VerifyResult>;
}

/** Utility: does a manifest object match a restore selection? */
export function matchesSelection(object: ManifestObject, selection: RestoreSelection): boolean {
  const hasFilter =
    (selection.paths?.length ?? 0) > 0 ||
    (selection.folderPaths?.length ?? 0) > 0 ||
    (selection.objectIds?.length ?? 0) > 0;
  if (selection.all || !hasFilter) {
    return true;
  }
  if (selection.paths?.includes(object.path)) {
    return true;
  }
  if (object.id !== undefined && selection.objectIds?.includes(object.id)) {
    return true;
  }
  if (selection.folderPaths) {
    for (const folder of selection.folderPaths) {
      const prefix = folder.endsWith("/") ? folder : `${folder}/`;
      if (object.path === folder || object.path.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}
