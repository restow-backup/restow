/**
 * The pack catalog: what the scrub job needs from the chunk index beyond the
 * read/write path (engine/types.ts ChunkIndex). The worker implements it over
 * the `packs` and `chunks` tables; tests use {@link MemoryPackCatalog}.
 */
import type { MemoryChunkIndex } from "../engine/memory.js";
import type { ChunkRecord, PackRecord } from "../engine/types.js";

/**
 * A pack the storage check could not read (a transfer or permission error,
 * not proven damage) in one or more consecutive checks. Any check that reads
 * it intact, or proves it damaged, ends the run of failures.
 */
export type PackUnreadableState = {
  /** The first check of the current run of failures. */
  readonly since: Date;
  /** The latest failed check. */
  readonly lastAt: Date;
  /** Consecutive checks that failed to read the pack. */
  readonly checks: number;
  /** The error of the latest failed check. */
  readonly detail: string | null;
};

export type CatalogPack = PackRecord & {
  readonly createdAt: Date;
  /** When a scrub found the pack damaged on every target; null (or absent) while it is intact. */
  readonly damagedAt?: Date | null;
  /** Set while the latest checks could not read the pack; null (or absent) otherwise. */
  readonly unreadable?: PackUnreadableState | null;
};

/** One failed read of a pack in a check, for {@link PackCatalog.recordUnreadable}. */
export type PackReadFailure = { readonly packId: string; readonly detail: string | null };

export type CatalogChunk = ChunkRecord & {
  readonly refcount: number;
  /** Last change of the row; for an unreferenced chunk, when it lost its last reference. */
  readonly updatedAt: Date;
};

/**
 * Swap a pack for its re-packed replacement. `moved` are the surviving chunks
 * with their offsets in `newPack`; `dropped` the unreferenced ones. `newPack`
 * is null when nothing survives.
 */
export type PackReplacement = {
  readonly oldPack: CatalogPack;
  readonly newPack: PackRecord | null;
  readonly moved: readonly ChunkRecord[];
  readonly dropped: readonly string[];
};

export interface PackCatalog {
  /** Every pack of the tenant. */
  listPacks(): Promise<CatalogPack[]>;
  /** The chunk rows that point into a pack. */
  chunksOf(packId: string): Promise<CatalogChunk[]>;
  /** Packs holding at least one unreferenced chunk whose row last changed before `cutoff`. */
  collectablePacks(cutoff: Date): Promise<CatalogPack[]>;
  /**
   * Apply a replacement atomically: record the new pack, repoint the moved
   * chunks, delete the dropped chunk rows and the old pack row. Must change
   * nothing and return false when the old pack's rows no longer match the
   * plan, in particular when a dropped chunk gained a reference meanwhile.
   */
  replacePack(change: PackReplacement): Promise<boolean>;
  /**
   * Mark packs damaged (`at`) or intact again (null). A damaged pack's chunks
   * stop counting for deduplication (see ChunkIndex), so later backups write
   * intact copies of what the source still holds. Marking keeps the first
   * damage time.
   */
  setDamaged(packIds: readonly string[], at: Date | null): Promise<void>;
  /**
   * Delete the row of a damaged pack no chunk row points to any more: every
   * chunk it held was written again elsewhere. Must change nothing and return
   * false when the pack is not damaged or still holds a chunk row.
   */
  retireDamagedPack(pack: CatalogPack): Promise<boolean>;
  /**
   * Count one more consecutive failed check for each pack (starting a run of
   * failures at `at` for a pack that had none) and keep the latest error.
   */
  recordUnreadable(failures: readonly PackReadFailure[], at: Date): Promise<void>;
  /** End the run of failed checks of these packs: they were read, intact or damaged. */
  clearUnreadable(packIds: readonly string[]): Promise<void>;
}

const EPOCH = new Date(0);

/** {@link PackCatalog} over the in-memory chunk index (tests and dry runs). */
export class MemoryPackCatalog implements PackCatalog {
  private readonly chunkTimes = new Map<string, Date>();
  private readonly packTimes = new Map<string, Date>();
  readonly unreadable = new Map<string, PackUnreadableState>();

  constructor(private readonly index: MemoryChunkIndex) {}

  /** Pin the last-change time of a chunk row (default: the epoch, i.e. long ago). */
  touchChunk(storedId: string, at: Date): void {
    this.chunkTimes.set(storedId, at);
  }

  touchPack(packId: string, at: Date): void {
    this.packTimes.set(packId, at);
  }

  async listPacks(): Promise<CatalogPack[]> {
    return [...this.index.packs.values()].map((pack) => ({
      ...pack,
      createdAt: this.packTimes.get(pack.id) ?? EPOCH,
      damagedAt: this.index.damaged.get(pack.id) ?? null,
      unreadable: this.unreadable.get(pack.id) ?? null,
    }));
  }

  async chunksOf(packId: string): Promise<CatalogChunk[]> {
    const pack = this.index.packs.get(packId);
    if (!pack) {
      return [];
    }
    const rows: CatalogChunk[] = [];
    for (const [storedId, entry] of this.index.chunks) {
      if (entry.packPath === pack.path) {
        rows.push({
          storedId,
          offset: entry.offset,
          length: entry.length,
          refcount: entry.refcount,
          updatedAt: this.chunkTimes.get(storedId) ?? EPOCH,
        });
      }
    }
    return rows.sort((a, b) => a.offset - b.offset);
  }

  async collectablePacks(cutoff: Date): Promise<CatalogPack[]> {
    const packs = await this.listPacks();
    const result: CatalogPack[] = [];
    for (const pack of packs) {
      const chunks = await this.chunksOf(pack.id);
      if (chunks.some((chunk) => chunk.refcount === 0 && chunk.updatedAt < cutoff)) {
        result.push(pack);
      }
    }
    return result;
  }

  async replacePack(change: PackReplacement): Promise<boolean> {
    const current = await this.chunksOf(change.oldPack.id);
    const byId = new Map(current.map((chunk) => [chunk.storedId, chunk]));
    const planned = change.moved.length + change.dropped.length;
    const consistent =
      current.length === planned &&
      change.moved.every((chunk) => byId.has(chunk.storedId)) &&
      change.dropped.every((id) => byId.get(id)?.refcount === 0);
    if (!consistent) {
      return false;
    }
    this.index.packs.delete(change.oldPack.id);
    this.unreadable.delete(change.oldPack.id);
    if (change.newPack) {
      this.index.packs.set(change.newPack.id, change.newPack);
    }
    for (const chunk of change.moved) {
      const entry = this.index.chunks.get(chunk.storedId);
      if (entry && change.newPack) {
        this.index.chunks.set(chunk.storedId, {
          ...entry,
          packPath: change.newPack.path,
          offset: chunk.offset,
          length: chunk.length,
        });
      }
    }
    for (const id of change.dropped) {
      this.index.chunks.delete(id);
    }
    return true;
  }

  async setDamaged(packIds: readonly string[], at: Date | null): Promise<void> {
    for (const id of packIds) {
      if (!this.index.packs.has(id)) {
        continue;
      }
      if (at === null) {
        this.index.damaged.delete(id);
      } else if (!this.index.damaged.has(id)) {
        this.index.damaged.set(id, at);
      }
    }
  }

  async retireDamagedPack(pack: CatalogPack): Promise<boolean> {
    if (!this.index.damaged.has(pack.id) || (await this.chunksOf(pack.id)).length > 0) {
      return false;
    }
    this.index.packs.delete(pack.id);
    this.index.damaged.delete(pack.id);
    this.unreadable.delete(pack.id);
    return true;
  }

  async recordUnreadable(failures: readonly PackReadFailure[], at: Date): Promise<void> {
    for (const { packId, detail } of failures) {
      if (!this.index.packs.has(packId)) {
        continue;
      }
      const previous = this.unreadable.get(packId);
      this.unreadable.set(packId, {
        since: previous?.since ?? at,
        lastAt: at,
        checks: (previous?.checks ?? 0) + 1,
        detail,
      });
    }
  }

  async clearUnreadable(packIds: readonly string[]): Promise<void> {
    for (const id of packIds) {
      this.unreadable.delete(id);
    }
  }
}
