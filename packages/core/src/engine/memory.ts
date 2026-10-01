/**
 * In-memory implementations of the engine's persistence seams.
 *
 * Used by the unit tests of every engine (docs/TESTING.md: fixtures, never live
 * services) and by dry runs. They implement exactly the same contracts as the
 * Postgres-backed versions in apps/worker, including the refcount and
 * "manifestPath null while in progress" semantics.
 */
import { randomUUID } from "node:crypto";
import type { ManifestObject } from "../manifest.js";
import type { StorageBackend } from "../storage/backend.js";
import { noopLogger } from "./logger.js";
import { type ProgressSink, ProgressTracker, type ProgressUpdate } from "./progress.js";
import type {
  ChunkIndex,
  ChunkLocation,
  ChunkRecord,
  CompleteSnapshotInput,
  Cursor,
  CursorStore,
  JobContext,
  JobQueue,
  Logger,
  NewSnapshotRecord,
  PackRecord,
  SecretReader,
  SnapshotIndex,
  SnapshotRecord,
  StorageTargets,
  TenantKeyring,
} from "./types.js";

export class MemoryChunkIndex implements ChunkIndex {
  readonly packs = new Map<string, PackRecord>();
  readonly chunks = new Map<string, ChunkLocation & { refcount: number }>();
  /** When a pack (by id) was marked damaged by the scrub. */
  readonly damaged = new Map<string, Date>();

  /** Whether the pack stored at `path` is marked damaged. */
  isDamagedPath(path: string): boolean {
    for (const [id, pack] of this.packs) {
      if (pack.path === path) {
        return this.damaged.has(id);
      }
    }
    return false;
  }

  async existing(storedIds: readonly string[]): Promise<Set<string>> {
    return new Set(
      storedIds.filter((id) => {
        const entry = this.chunks.get(id);
        return entry !== undefined && !this.isDamagedPath(entry.packPath);
      }),
    );
  }

  async recordPack(pack: PackRecord, chunks: readonly ChunkRecord[]): Promise<void> {
    this.packs.set(pack.id, pack);
    for (const chunk of chunks) {
      const entry = this.chunks.get(chunk.storedId);
      if (!entry) {
        this.chunks.set(chunk.storedId, { ...chunk, packPath: pack.path, refcount: 0 });
      } else if (entry.packPath !== pack.path && this.isDamagedPath(entry.packPath)) {
        // An intact copy of a chunk whose pack is damaged: the row moves, the references stay.
        this.chunks.set(chunk.storedId, {
          ...chunk,
          packPath: pack.path,
          refcount: entry.refcount,
        });
      }
    }
  }

  async locate(storedIds: readonly string[]): Promise<Map<string, ChunkLocation>> {
    const result = new Map<string, ChunkLocation>();
    for (const id of storedIds) {
      const entry = this.chunks.get(id);
      if (entry) {
        const { refcount: _ignored, ...location } = entry;
        result.set(id, location);
      }
    }
    return result;
  }

  async addReferences(storedIds: readonly string[]): Promise<void> {
    for (const id of storedIds) {
      const entry = this.chunks.get(id);
      if (entry) {
        entry.refcount++;
      }
    }
  }

  async releaseReferences(storedIds: readonly string[]): Promise<void> {
    for (const id of storedIds) {
      const entry = this.chunks.get(id);
      if (entry && entry.refcount > 0) {
        entry.refcount--;
      }
    }
  }
}

export class MemorySnapshotIndex implements SnapshotIndex {
  readonly rows = new Map<string, SnapshotRecord>();
  readonly objects = new Map<string, ManifestObject[]>();

  constructor(private readonly tenantId: string) {}

  async latestCompleted(protectedObjectId: string): Promise<SnapshotRecord | null> {
    let best: SnapshotRecord | null = null;
    for (const row of this.rows.values()) {
      if (
        row.protectedObjectId === protectedObjectId &&
        row.manifestPath !== null &&
        row.status === "active" &&
        (best === null || row.sequence > best.sequence)
      ) {
        best = row;
      }
    }
    return best;
  }

  async get(snapshotId: string): Promise<SnapshotRecord | null> {
    return this.rows.get(snapshotId) ?? null;
  }

  async nextSequence(protectedObjectId: string): Promise<number> {
    let max = 0;
    for (const row of this.rows.values()) {
      if (row.protectedObjectId === protectedObjectId) {
        max = Math.max(max, row.sequence);
      }
    }
    return max + 1;
  }

  async create(input: NewSnapshotRecord): Promise<SnapshotRecord> {
    const row: SnapshotRecord = {
      id: input.id,
      tenantId: this.tenantId,
      protectedObjectId: input.protectedObjectId,
      jobId: input.jobId,
      sequence: input.sequence,
      manifestPath: null,
      status: "active",
      itemCount: 0,
      byteSize: 0,
      startedAt: input.startedAt,
      completedAt: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async complete(snapshotId: string, input: CompleteSnapshotInput): Promise<void> {
    const row = this.rows.get(snapshotId);
    if (!row) {
      throw new Error(`snapshot ${snapshotId} does not exist`);
    }
    this.rows.set(snapshotId, { ...row, ...input });
  }

  async recordObjects(snapshotId: string, objects: readonly ManifestObject[]): Promise<void> {
    this.objects.set(snapshotId, [...objects]);
  }

  async discard(snapshotId: string): Promise<void> {
    this.rows.delete(snapshotId);
    this.objects.delete(snapshotId);
  }
}

/** Secrets by id, in plaintext (tests only). */
export class MemorySecretReader implements SecretReader {
  constructor(private readonly values: Record<string, string> = {}) {}

  async get(secretId: string): Promise<string | null> {
    return this.values[secretId] ?? null;
  }
}

export class MemoryCursorStore implements CursorStore {
  cursor: Cursor | null = null;
  saves = 0;

  async load(): Promise<Cursor | null> {
    return this.cursor ? structuredClone(this.cursor) : null;
  }

  async save(cursor: Cursor): Promise<void> {
    this.cursor = structuredClone(cursor);
    this.saves++;
  }

  async clear(): Promise<void> {
    this.cursor = null;
  }
}

/** Collects every published update, for assertions. */
export class MemoryProgressSink implements ProgressSink {
  readonly updates: ProgressUpdate[] = [];

  async publish(update: ProgressUpdate): Promise<void> {
    this.updates.push(update);
  }

  get last(): ProgressUpdate | undefined {
    return this.updates[this.updates.length - 1];
  }

  get failures(): ProgressUpdate["failures"][number][] {
    return this.updates.flatMap((update) => [...update.failures]);
  }
}

export interface MemoryJobContextOptions {
  readonly tenantId: string;
  readonly keys: TenantKeyring;
  readonly storage: StorageBackend | StorageTargets;
  readonly queue?: JobQueue;
  readonly jobId?: string;
  readonly attempt?: number;
  readonly chunkIndex?: ChunkIndex;
  readonly snapshots?: SnapshotIndex;
  readonly cursor?: CursorStore;
  readonly secrets?: SecretReader | Record<string, string>;
  readonly progressSink?: ProgressSink;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly db?: unknown;
}

function isTargets(value: StorageBackend | StorageTargets): value is StorageTargets {
  return "primary" in value && "copies" in value;
}

/** A complete {@link JobContext} over in-memory seams, for engine tests. */
export function createMemoryJobContext(options: MemoryJobContextOptions): JobContext & {
  readonly progressSink: ProgressSink;
} {
  const storage: StorageTargets = isTargets(options.storage)
    ? options.storage
    : { primary: options.storage, copies: [] };
  const progressSink = options.progressSink ?? new MemoryProgressSink();
  return {
    jobId: options.jobId ?? randomUUID(),
    tenantId: options.tenantId,
    queue: options.queue ?? "backup",
    attempt: options.attempt ?? 0,
    db: options.db,
    storage,
    keys: options.keys,
    secrets:
      options.secrets === undefined
        ? new MemorySecretReader()
        : "get" in options.secrets && typeof options.secrets.get === "function"
          ? (options.secrets as SecretReader)
          : new MemorySecretReader(options.secrets as Record<string, string>),
    chunkIndex: options.chunkIndex ?? new MemoryChunkIndex(),
    snapshots: options.snapshots ?? new MemorySnapshotIndex(options.tenantId),
    progress: new ProgressTracker({ sink: progressSink, flushEveryItems: 1, flushIntervalMs: 0 }),
    cursor: options.cursor ?? new MemoryCursorStore(),
    logger: options.logger ?? noopLogger,
    signal: options.signal ?? new AbortController().signal,
    now: options.now ?? (() => new Date()),
    progressSink,
  };
}
