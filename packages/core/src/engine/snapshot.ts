/**
 * SnapshotWriter: assembles one snapshot of one protected object.
 *
 * It owns a {@link ChunkWriter} for the object bytes and collects the
 * {@link ManifestObject} list. Two durability points matter:
 *
 *   checkpoint()  flushes packs, writes a partial manifest to storage and saves
 *                 the job cursor (with the checkpoint inside). A worker that
 *                 restarts resumes from here without re-downloading anything
 *                 it already stored (docs/ARCHITECTURE.md, Wiederaufnahme).
 *   commit()      verifies every referenced chunk is locatable, writes the final
 *                 manifest to every storage target, mirrors the object list to
 *                 Postgres, bumps chunk refcounts and marks the snapshot row
 *                 complete. Until commit() the snapshot row has no manifest and
 *                 is invisible to restore and verify.
 *
 * Both write the manifest sealed with the tenant DEK and bound to its storage
 * key (./sealed-manifest.ts): object paths, subjects and hashes never reach a
 * storage target in clear text.
 *
 * Both refuse to run once the chunk writer lost a pack, or while any chunk it
 * handed out is not stored yet: a checkpoint naming a lost chunk would make
 * every retry redo its work only to fail at commit. The retry resumes from the
 * last good checkpoint instead.
 *
 * Objects are keyed by path: adding an object with an existing path replaces
 * it, which is how incremental runs overwrite changed items after `inherit()`
 * carried the previous snapshot forward.
 */
import { randomUUID } from "node:crypto";
import {
  MANIFEST_VERSION,
  type ManifestObject,
  type ManifestSource,
  type SnapshotManifest,
} from "../manifest.js";
import { ChunkWriter, readFromAnyTargetAs, writeToAllTargets } from "./chunkstore.js";
import { deletePartialManifest, discardUncommittedSnapshot } from "./discard.js";
import { manifestKey, partialManifestKey } from "./layout.js";
import { noopLogger } from "./logger.js";
import { openManifest, sealManifest } from "./sealed-manifest.js";
import type {
  Cursor,
  JobContext,
  Logger,
  ProtectedObjectRef,
  SnapshotCheckpoint,
  SnapshotRecord,
  SourceKind,
  StorageTargets,
  TenantKeyring,
} from "./types.js";

const LOCATE_BATCH = 1000;

export interface BeginSnapshotOptions {
  readonly protectedObject: ProtectedObjectRef;
  readonly sourceType: SourceKind;
  /** Resume the snapshot a previous attempt checkpointed (from the job cursor). */
  readonly checkpoint?: SnapshotCheckpoint;
  readonly maxPackBytes?: number;
  readonly snapshotIdGenerator?: () => string;
  readonly packIdGenerator?: () => string;
}

export interface CommittedSnapshot {
  readonly snapshotId: string;
  readonly sequence: number;
  readonly manifestPath: string;
  readonly itemCount: number;
  readonly byteSize: number;
  /** Packs referenced by the manifest. */
  readonly packCount: number;
}

/**
 * Read and decode a manifest from storage (primary first, copies as fallback).
 * The manifest must be sealed and opens with the tenant keyring, bound to
 * `key` (sealed-manifest.ts's doc comment: every manifest this product
 * writes is sealed, so unsealed bytes here are refused, never trusted, since
 * they can only mean a storage target was written to outside the product —
 * `openManifest` is never given `allowUnsealed`). A copy that is missing or
 * does not open and decode (truncated, damaged, unsealed) is passed over for
 * the next target.
 */
export async function loadManifest(
  storage: StorageTargets,
  key: string,
  keys: Pick<TenantKeyring, "open">,
): Promise<SnapshotManifest> {
  return readFromAnyTargetAs(storage, key, (bytes) =>
    openManifest(bytes, {
      open: (sealed) => keys.open(sealed),
      storageKey: key,
    }),
  );
}

/** The newest committed manifest of a protected object, or null before the first backup. */
export async function loadLatestManifest(
  ctx: Pick<JobContext, "snapshots" | "storage" | "keys">,
  protectedObjectId: string,
): Promise<{ record: SnapshotRecord; manifest: SnapshotManifest } | null> {
  const record = await ctx.snapshots.latestCompleted(protectedObjectId);
  if (!record || !record.manifestPath) {
    return null;
  }
  return { record, manifest: await loadManifest(ctx.storage, record.manifestPath, ctx.keys) };
}

export class SnapshotWriter {
  readonly snapshotId: string;
  readonly sequence: number;
  readonly chunks: ChunkWriter;
  /** The previous completed snapshot of the same object, for incremental carry-over. */
  readonly previous: SnapshotRecord | null;
  private readonly objects = new Map<string, ManifestObject>();
  private engineState: Record<string, unknown> | undefined;
  private readonly logger: Logger;
  private readonly source: ManifestSource;
  private committed: CommittedSnapshot | null = null;
  private aborted = false;

  private constructor(
    private readonly ctx: JobContext,
    options: BeginSnapshotOptions,
    snapshotId: string,
    sequence: number,
    previous: SnapshotRecord | null,
  ) {
    this.snapshotId = snapshotId;
    this.sequence = sequence;
    this.previous = previous;
    this.logger = ctx.logger.child({ component: "snapshot-writer", snapshotId });
    this.source = {
      type: options.sourceType,
      id: options.protectedObject.externalId,
      kind: options.protectedObject.kind,
      protectedObjectId: options.protectedObject.id,
    };
    this.chunks = new ChunkWriter({
      tenantId: ctx.tenantId,
      storage: ctx.storage,
      keys: ctx.keys,
      index: ctx.chunkIndex,
      maxPackBytes: options.maxPackBytes,
      logger: ctx.logger,
      signal: ctx.signal,
      packIdGenerator: options.packIdGenerator,
    });
  }

  /** Start a new snapshot, or resume the checkpointed one. */
  static async begin(ctx: JobContext, options: BeginSnapshotOptions): Promise<SnapshotWriter> {
    const objectId = options.protectedObject.id;
    const previous = await ctx.snapshots.latestCompleted(objectId);

    if (options.checkpoint) {
      const resumed = await SnapshotWriter.resume(ctx, options, previous);
      if (resumed) {
        return resumed;
      }
    }

    const sequence = await ctx.snapshots.nextSequence(objectId);
    const snapshotId = (options.snapshotIdGenerator ?? randomUUID)();
    await ctx.snapshots.create({
      id: snapshotId,
      protectedObjectId: objectId,
      jobId: ctx.jobId,
      sequence,
      startedAt: ctx.now(),
    });
    const writer = new SnapshotWriter(ctx, options, snapshotId, sequence, previous);
    writer.logger.info("snapshot started", { sequence, protectedObjectId: objectId });
    return writer;
  }

  /**
   * Rebuild the writer from a checkpoint. Returns null when the checkpoint no
   * longer matches reality (row gone, already completed, partial unreadable);
   * the caller then starts a fresh snapshot, which costs a re-enumeration but
   * never correctness. The checkpoint it gives up on is cleaned up first: its
   * partial manifest would otherwise pin its chunks against garbage collection
   * forever (or, unreadable, block collection for the tenant), and an
   * in-progress row nothing resumes any more is dropped.
   */
  private static async resume(
    ctx: JobContext,
    options: BeginSnapshotOptions,
    previous: SnapshotRecord | null,
  ): Promise<SnapshotWriter | null> {
    const checkpoint = options.checkpoint as SnapshotCheckpoint;
    const logger = (ctx.logger ?? noopLogger).child({ snapshotId: checkpoint.snapshotId });
    const record = await ctx.snapshots.get(checkpoint.snapshotId);
    if (!record || record.manifestPath !== null) {
      logger.warn("checkpoint does not match an in-progress snapshot, starting over");
      await SnapshotWriter.discardStale(ctx, checkpoint.snapshotId, logger);
      return null;
    }
    let partial: SnapshotManifest;
    try {
      partial = await loadManifest(ctx.storage, checkpoint.partialKey, ctx.keys);
    } catch (error) {
      logger.warn("partial manifest is unreadable, starting over", { error });
      await SnapshotWriter.discardStale(ctx, checkpoint.snapshotId, logger);
      return null;
    }
    const writer = new SnapshotWriter(ctx, options, record.id, record.sequence, previous);
    for (const object of partial.objects) {
      writer.objects.set(object.path, object);
    }
    writer.engineState = partial.state;
    logger.info("snapshot resumed from checkpoint", {
      sequence: record.sequence,
      objects: partial.objects.length,
    });
    return writer;
  }

  /**
   * Remove a checkpoint this job gives up on (see {@link discardUncommittedSnapshot}).
   * Best effort: a failure is logged and the fresh snapshot starts anyway; the
   * worker's cleanup and garbage collection pick up whatever stays behind.
   */
  private static async discardStale(
    ctx: JobContext,
    snapshotId: string,
    logger: Logger,
  ): Promise<void> {
    try {
      const outcome = await discardUncommittedSnapshot(
        { tenantId: ctx.tenantId, storage: ctx.storage, snapshots: ctx.snapshots, logger },
        snapshotId,
      );
      logger.info("stale checkpoint removed", { outcome });
    } catch (error) {
      logger.warn("could not remove a stale checkpoint", { error });
    }
  }

  /** The previous snapshot's manifest, or null before the first backup. */
  async loadPreviousManifest(): Promise<SnapshotManifest | null> {
    if (!this.previous?.manifestPath) {
      return null;
    }
    return loadManifest(this.ctx.storage, this.previous.manifestPath, this.ctx.keys);
  }

  get objectCount(): number {
    return this.objects.size;
  }

  has(path: string): boolean {
    return this.objects.has(path);
  }

  get(path: string): ManifestObject | undefined {
    return this.objects.get(path);
  }

  /** Add an object, replacing any object already recorded at the same path. */
  add(object: ManifestObject): void {
    this.assertWritable();
    this.objects.set(object.path, object);
  }

  /** Drop an object (a deletion seen by the delta query). */
  remove(path: string): boolean {
    this.assertWritable();
    return this.objects.delete(path);
  }

  /**
   * Carry the previous snapshot's objects forward (unchanged items of an
   * incremental run). Objects already added in this run are kept as they are.
   * Returns how many objects were inherited.
   */
  inherit(previous: SnapshotManifest, keep?: (object: ManifestObject) => boolean): number {
    this.assertWritable();
    let count = 0;
    for (const object of previous.objects) {
      if (this.objects.has(object.path) || (keep && !keep(object))) {
        continue;
      }
      this.objects.set(object.path, object);
      count++;
    }
    return count;
  }

  /** Engine-specific incremental state stored with the manifest (delta links etc.). */
  get state(): Record<string, unknown> | undefined {
    return this.engineState;
  }

  setState(state: Record<string, unknown> | undefined): void {
    this.assertWritable();
    this.engineState = state;
  }

  /** Objects in path order. */
  listObjects(): ManifestObject[] {
    return [...this.objects.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }

  private buildManifest(packs?: string[]): SnapshotManifest {
    const manifest: SnapshotManifest = {
      version: MANIFEST_VERSION,
      tenantId: this.ctx.tenantId,
      snapshotId: this.snapshotId,
      createdAt: this.ctx.now().getTime(),
      source: this.source,
      sequence: this.sequence,
      objects: this.listObjects(),
    };
    if (packs) {
      manifest.packs = packs;
    }
    if (this.engineState) {
      manifest.state = this.engineState;
    }
    return manifest;
  }

  /**
   * Make everything so far durable and record the resume point: packs first,
   * partial manifest second, cursor last, so a cursor never points at data that
   * does not exist. `cursor` carries the engine's own position (folder, delta
   * token, last item); the checkpoint is merged in under `snapshot`.
   */
  async checkpoint(cursor: Omit<Cursor, "snapshot"> = {}): Promise<SnapshotCheckpoint> {
    this.assertWritable();
    await this.chunks.flush();
    this.assertChunksStored("checkpoint");
    const partialKey = partialManifestKey(this.ctx.tenantId, this.snapshotId);
    await writeToAllTargets(
      this.ctx.storage,
      partialKey,
      await sealManifest(this.buildManifest(), this.ctx.keys.current, partialKey),
    );
    const checkpoint: SnapshotCheckpoint = {
      snapshotId: this.snapshotId,
      sequence: this.sequence,
      partialKey,
      objectCount: this.objects.size,
    };
    await this.ctx.cursor.save({ ...cursor, snapshot: checkpoint });
    this.logger.debug("checkpoint saved", { objects: checkpoint.objectCount });
    return checkpoint;
  }

  /** Every chunk id referenced by the current object list, in object order (with repeats). */
  private referencedChunkIds(): string[] {
    const ids: string[] = [];
    for (const object of this.objects.values()) {
      ids.push(...object.chunks);
    }
    return ids;
  }

  /**
   * Resolve the packs behind every referenced chunk. Throws if any chunk is not
   * locatable: a manifest must never be committed with a dangling reference.
   */
  private async resolvePacks(ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const packs = new Set<string>();
    for (let i = 0; i < unique.length; i += LOCATE_BATCH) {
      const batch = unique.slice(i, i + LOCATE_BATCH);
      const located = await this.ctx.chunkIndex.locate(batch);
      for (const id of batch) {
        const location = located.get(id);
        if (!location) {
          throw new Error(
            `refusing to commit snapshot ${this.snapshotId}: chunk ${id} is not locatable`,
          );
        }
        packs.add(location.packPath);
      }
    }
    return [...packs].sort();
  }

  /** Add or release one reference per occurrence of each chunk id, in batches. */
  private async adjustReferences(ids: readonly string[], change: "add" | "release"): Promise<void> {
    for (let i = 0; i < ids.length; i += LOCATE_BATCH) {
      const batch = ids.slice(i, i + LOCATE_BATCH);
      if (change === "add") {
        await this.ctx.chunkIndex.addReferences(batch);
      } else {
        await this.ctx.chunkIndex.releaseReferences(batch);
      }
    }
  }

  /** Finalize the snapshot. Idempotent: a second call returns the same result. */
  async commit(): Promise<CommittedSnapshot> {
    if (this.committed) {
      return this.committed;
    }
    this.assertWritable();
    await this.chunks.close();
    this.assertChunksStored("commit");

    const ids = this.referencedChunkIds();
    // Hold the references before checking that every chunk is locatable. The
    // scrub's garbage collection only reclaims chunks without references (and
    // re-checks that under row locks), so a chunk found here stays until this
    // snapshot is pruned; checked the other way round, a chunk could vanish
    // between the check and the reference and leave a dangling manifest.
    await this.adjustReferences(ids, "add");
    let committed: CommittedSnapshot;
    try {
      committed = await this.writeManifest(ids);
    } catch (error) {
      // Not committed: the snapshot must not keep its chunks alive (a retry
      // takes its own references).
      await this.adjustReferences(ids, "release").catch((releaseError: unknown) => {
        this.logger.warn("could not release chunk references of a failed commit", {
          error: releaseError,
        });
      });
      throw error;
    }
    await this.deletePartial();

    this.committed = committed;
    this.logger.info("snapshot committed", {
      sequence: this.sequence,
      objects: committed.itemCount,
      bytes: committed.byteSize,
      packs: committed.packCount,
      newChunks: this.chunks.stats.chunksNew,
      newBytes: this.chunks.stats.bytesNew,
    });
    return committed;
  }

  /** Locate every chunk, write the final manifest to all targets and complete the row. */
  private async writeManifest(ids: readonly string[]): Promise<CommittedSnapshot> {
    const packs = await this.resolvePacks(ids);
    const manifest = this.buildManifest(packs);
    const path = manifestKey(this.ctx.tenantId, this.snapshotId);
    const byteSize = manifest.objects.reduce((sum, object) => sum + object.size, 0);

    await writeToAllTargets(
      this.ctx.storage,
      path,
      await sealManifest(manifest, this.ctx.keys.current, path),
    );
    await this.ctx.snapshots.recordObjects(this.snapshotId, manifest.objects);
    await this.ctx.snapshots.complete(this.snapshotId, {
      manifestPath: path,
      itemCount: manifest.objects.length,
      byteSize,
      completedAt: this.ctx.now(),
    });
    return {
      snapshotId: this.snapshotId,
      sequence: this.sequence,
      manifestPath: path,
      itemCount: manifest.objects.length,
      byteSize,
      packCount: packs.length,
    };
  }

  /**
   * Give up on an uncommitted snapshot: drop the in-progress row, the partial
   * manifest and a final manifest a failed commit may have left. Packs already
   * written stay (unreferenced, reclaimed by GC) so a later run can still
   * deduplicate against them.
   */
  async abort(): Promise<void> {
    if (this.committed || this.aborted) {
      return;
    }
    this.aborted = true;
    await discardUncommittedSnapshot(this.cleanupEnv(), this.snapshotId);
    this.logger.warn("snapshot aborted", { sequence: this.sequence });
  }

  private cleanupEnv() {
    return {
      tenantId: this.ctx.tenantId,
      storage: this.ctx.storage,
      snapshots: this.ctx.snapshots,
      logger: this.logger,
    };
  }

  private async deletePartial(): Promise<void> {
    await deletePartialManifest(this.cleanupEnv(), this.snapshotId);
  }

  /**
   * After the writer's own flush every chunk handed out must be in a stored
   * pack. A failed chunk writer throws its failure; chunks still pending (a
   * write that ran while the pack was flushed) are refused rather than named.
   */
  private assertChunksStored(action: "checkpoint" | "commit"): void {
    if (this.chunks.failed) {
      throw this.chunks.failed;
    }
    const pending = this.chunks.pendingChunkCount;
    if (pending > 0) {
      throw new Error(
        `refusing to ${action} snapshot ${this.snapshotId}: ${pending} chunk(s) are not stored yet`,
      );
    }
  }

  private assertWritable(): void {
    if (this.committed) {
      throw new Error(`snapshot ${this.snapshotId} is already committed`);
    }
    if (this.aborted) {
      throw new Error(`snapshot ${this.snapshotId} was aborted`);
    }
  }
}
