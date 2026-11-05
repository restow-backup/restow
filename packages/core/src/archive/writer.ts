/**
 * The archive item writer: stores one item's original bytes byte-exact and
 * encrypted through the existing chunk and pack store (deduplicated per
 * tenant, exactly like a backup object), then writes a sealed item record
 * that ties those chunks together with the hash chain and retention
 * (./format.ts, ./chain.ts, ./retention.ts). See FORMAT.md for the on-disk
 * picture this produces.
 *
 * Chunk liveness: an archived item's chunks are pinned with
 * `ChunkIndex.addReferences` right after they are written, exactly as
 * `engine/snapshot.ts` pins a backup's chunks on commit. Without this, scrub
 * garbage collection (`verify/gc.ts`) would see refcount 0 on any chunk no
 * backup happens to share and reclaim it once its grace period elapsed,
 * silently breaking `readArchiveItemOriginal` for an item whose sealed
 * record otherwise still looks intact. References are released only by the
 * retention deletion run (ARCHIVE-JOURNAL), never here.
 *
 * Write-once: the item record's storage key is checked before anything is
 * written, and {@link ArchiveWriteOnceError} refuses a second write to the
 * same key. This is an application-level guarantee (docs/ARCHIVE.md: on a
 * target without hardware WORM, Restow enforces immutability in code); a
 * target that also supports object-lock retention gets that too for the
 * item's own record, via `PutOptions.retainUntil` (storage/backend.ts) — no
 * storage-backend change was needed for that, the option already existed.
 * That retention intent covers only the small sealed record; the original
 * message bytes live in shared packs (see FORMAT.md, "Object-lock covers the
 * record, not the pack") which today carry no `retainUntil` and can be
 * re-packed or deleted by GC once unreferenced, so hardware WORM does not
 * yet protect the message content itself — tracked as a follow-up for
 * ARCHIVE-JOURNAL/STORAGE-CLASSIFICATION.
 *
 * The write-once check (`head` then `put`) is a read-then-write, not an
 * atomic conditional create: two concurrent writers racing the same item id
 * can both pass the `head` check before either `put` lands. Callers must
 * serialize writes per item id themselves (the journal receiver's
 * transaction or an advisory lock); a backend that supports a conditional
 * create (If-None-Match, `O_EXCL`) should prefer that where available.
 *
 * This module does not touch the {@link ArchiveCatalog}: the caller appends
 * the returned record itself, in the same transaction it uses to look up
 * `prevChainHash` (./append.ts does this under the tenant's chain lock, so
 * the lookup and the append are atomic; nothing here could make that
 * guarantee on its own).
 *
 * Two halves (0.4.4): {@link storeArchiveContent} chunks and uploads the
 * original and pins nothing, so it can run outside the chain lock (the
 * upload is the slow part; scrub GC's grace period keeps freshly written
 * chunks alive until they are referenced); {@link commitArchiveItem} pins the
 * chunks, links the record into the chain and writes it, under the lock.
 * The grace period does not cover a chunk deduplication found already old
 * and unreferenced (left over from a pruned backup): GC may collect it
 * between the two halves. The commit therefore checks after pinning that
 * every chunk is still locatable and otherwise throws
 * {@link ArchiveChunksMissingError}; the caller stores the content again,
 * which rewrites the missing chunks, and commits once more (0.5.0).
 * {@link writeArchiveItem} does both in one call, as before.
 */
import type { ObjectInput } from "../engine/chunkstore.js";
import { ChunkWriter } from "../engine/chunkstore.js";
import type { ChunkIndex, Logger, StorageTargets, TenantKeyring } from "../engine/types.js";
import type { PutOptions } from "../storage/backend.js";
import { computeArchiveChainHash } from "./chain.js";
import { sealArchiveItem } from "./format.js";
import type { JournalEnvelope } from "./journal.js";
import { archiveItemKey } from "./layout.js";
import { type RetentionPolicy, retentionUntil } from "./retention.js";
import type { ArchiveFlag, ArchiveItemRecord, ArchiveSource } from "./types.js";

export interface StoreArchiveContentOptions {
  readonly tenantId: string;
  readonly storage: StorageTargets;
  readonly keys: TenantKeyring;
  readonly index: ChunkIndex;
  readonly original: ObjectInput;
  readonly logger?: Logger;
}

/** An original stored in the chunk store, not yet referenced by any item. */
export interface ArchiveContent {
  /** SHA-256 (hex) of the original, byte-exact. */
  readonly itemHash: string;
  readonly size: number;
  /** Ordered stored chunk ids (hex). */
  readonly chunks: readonly string[];
}

export interface CommitArchiveItemOptions {
  readonly tenantId: string;
  /** Catalog identity for this item, assigned by the caller. */
  readonly itemId: string;
  readonly storage: StorageTargets;
  readonly keys: TenantKeyring;
  readonly index: ChunkIndex;
  readonly content: ArchiveContent;
  readonly receivedAt: Date;
  readonly envelope: JournalEnvelope | null;
  readonly flags: readonly ArchiveFlag[];
  readonly source: ArchiveSource;
  readonly retentionPolicy: RetentionPolicy;
  readonly legalHold?: boolean;
  /** The tenant chain's current last chain hash, or null for the first item. */
  readonly prevChainHash: string | null;
  /** When the record is written: strictly after the chain's last item (./append.ts). */
  readonly createdAt: Date;
  readonly bodyHash?: string;
  readonly supersedesItemId?: string;
}

export interface WriteArchiveItemOptions {
  readonly tenantId: string;
  /** Catalog identity for this item, assigned by the caller. */
  readonly itemId: string;
  readonly storage: StorageTargets;
  readonly keys: TenantKeyring;
  readonly index: ChunkIndex;
  readonly original: ObjectInput;
  readonly receivedAt: Date;
  readonly envelope: JournalEnvelope | null;
  readonly flags: readonly ArchiveFlag[];
  readonly source: ArchiveSource;
  readonly retentionPolicy: RetentionPolicy;
  readonly legalHold?: boolean;
  /** The tenant chain's current last chain hash (from `ArchiveCatalog.lastChainHash`), or null for the first item. */
  readonly prevChainHash: string | null;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

/**
 * Thrown by {@link commitArchiveItem} when a chunk of the content is gone by the time it is
 * pinned: deduplication found it in the index, but scrub GC collected it (refcount 0 past
 * its grace period) before the reference landed. The references just taken are released
 * again; the caller stores the content once more (the missing chunks are then rewritten,
 * since the index no longer has them) and commits again. Nothing is committed with a
 * chunk that exists nowhere.
 */
export class ArchiveChunksMissingError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `refusing to commit archive item: ${missing.length} chunk(s) are not locatable (first ${missing[0]}); the content must be stored again`,
    );
    this.name = "ArchiveChunksMissingError";
  }
}

/** How often a commit is tried when chunks vanish in between (each try stores again). */
export const ARCHIVE_COMMIT_ATTEMPTS = 3;

/** Chunk ids per `locate`/reference call, as the snapshot commit batches them. */
const PIN_BATCH = 1000;

/**
 * Take one reference per chunk occurrence, then check that every chunk is still locatable.
 * The order matters (as in `engine/snapshot.ts`): scrub GC only drops chunks without
 * references and re-checks that under row locks, so a chunk found after the reference
 * stays; a chunk GC dropped before it is missing here, and the update of its refcount
 * matched nothing. On a missing chunk the references are released and
 * {@link ArchiveChunksMissingError} is thrown.
 */
async function pinChunks(index: ChunkIndex, chunks: readonly string[]): Promise<void> {
  for (let i = 0; i < chunks.length; i += PIN_BATCH) {
    await index.addReferences(chunks.slice(i, i + PIN_BATCH));
  }
  const unique = [...new Set(chunks)];
  const missing: string[] = [];
  for (let i = 0; i < unique.length; i += PIN_BATCH) {
    const batch = unique.slice(i, i + PIN_BATCH);
    const located = await index.locate(batch);
    for (const id of batch) {
      if (!located.has(id)) {
        missing.push(id);
      }
    }
  }
  if (missing.length > 0) {
    for (let i = 0; i < chunks.length; i += PIN_BATCH) {
      await index.releaseReferences(chunks.slice(i, i + PIN_BATCH));
    }
    throw new ArchiveChunksMissingError(missing);
  }
}

/** Thrown when an archive item's storage key already exists; archived items are write-once. */
export class ArchiveWriteOnceError extends Error {
  constructor(readonly itemKey: string) {
    super(
      `archive item already exists at ${itemKey}; archived items are write-once and cannot be overwritten`,
    );
    this.name = "ArchiveWriteOnceError";
  }
}

async function putOnAllTargets(
  storage: StorageTargets,
  key: string,
  bytes: Buffer,
  options: PutOptions,
): Promise<void> {
  await storage.primary.put(key, bytes, options);
  await Promise.all(storage.copies.map((copy) => copy.put(key, bytes, options)));
}

/**
 * Chunk, dedupe and seal an original into the tenant's pack store. Pins nothing: the
 * chunks stay unreferenced until {@link commitArchiveItem} (scrub GC's grace period
 * covers the time in between), so a capture that turns out to be a duplicate costs no
 * reference to release.
 */
export async function storeArchiveContent(
  options: StoreArchiveContentOptions,
): Promise<ArchiveContent> {
  const writer = new ChunkWriter({
    tenantId: options.tenantId,
    storage: options.storage,
    keys: options.keys,
    index: options.index,
    logger: options.logger,
  });
  const written = await writer.write(options.original);
  await writer.close();
  return { itemHash: written.sha256, size: written.size, chunks: written.chunks };
}

/**
 * Pin a stored original's chunks, link it into the chain and write its sealed record.
 * Runs under the caller's chain lock; returns the record the caller appends to the
 * catalog in the same transaction. Throws {@link ArchiveChunksMissingError} (references
 * released, nothing written) when a chunk vanished since it was stored.
 */
export async function commitArchiveItem(
  options: CommitArchiveItemOptions,
): Promise<ArchiveItemRecord> {
  const itemKey = archiveItemKey(options.tenantId, options.receivedAt, options.itemId);
  const existing = await options.storage.primary.head(itemKey);
  if (existing) {
    throw new ArchiveWriteOnceError(itemKey);
  }
  // Pin the chunks this item needs: without a reference, scrub GC treats
  // them as unreferenced (no backup shares them) and reclaims them after its
  // grace period, which would silently break restore of this item later.
  // A deduplicated chunk may already be old and unreferenced, and GC does not
  // wait for captures: pinChunks checks after the reference that every chunk
  // still exists and throws ArchiveChunksMissingError otherwise.
  await pinChunks(options.index, options.content.chunks);

  const chainHash = computeArchiveChainHash(
    options.prevChainHash,
    options.content.itemHash,
    options.receivedAt,
  );
  const retentionUntilDate = retentionUntil(options.receivedAt, options.retentionPolicy);

  const record: ArchiveItemRecord = {
    id: options.itemId,
    tenantId: options.tenantId,
    receivedAt: options.receivedAt,
    itemHash: options.content.itemHash,
    prevChainHash: options.prevChainHash,
    chainHash,
    size: options.content.size,
    chunks: options.content.chunks,
    envelope: options.envelope,
    flags: [...options.flags],
    source: options.source,
    legalHold: options.legalHold ?? false,
    retentionUntil: retentionUntilDate,
    createdAt: options.createdAt,
    ...(options.bodyHash !== undefined ? { bodyHash: options.bodyHash } : {}),
    ...(options.supersedesItemId !== undefined
      ? { supersedesItemId: options.supersedesItemId }
      : {}),
  };

  const sealed = sealArchiveItem(record, options.keys.current, itemKey);
  const putOptions: PutOptions = { contentType: "application/json" };
  // Object-lock intent for the item's own sealed record, straight through the
  // existing StorageBackend contract (storage/backend.ts already carries
  // `retainUntil`; nothing to add there). This does not yet reach the
  // message's chunks in the shared pack store — see the module docstring and
  // FORMAT.md.
  if (record.retentionUntil) {
    putOptions.retainUntil = record.retentionUntil;
  }
  await putOnAllTargets(options.storage, itemKey, sealed, putOptions);

  return record;
}

/**
 * Write one archived item: chunk, dedupe and seal the original bytes into
 * the pack store, then write its sealed record. Returns the record the
 * caller must append to the {@link ArchiveCatalog}. The caller holds the chain
 * lock around the whole call; ./append.ts uploads outside it instead.
 */
export async function writeArchiveItem(
  options: WriteArchiveItemOptions,
): Promise<ArchiveItemRecord> {
  const itemKey = archiveItemKey(options.tenantId, options.receivedAt, options.itemId);
  if (await options.storage.primary.head(itemKey)) {
    throw new ArchiveWriteOnceError(itemKey);
  }
  for (let attempt = 1; ; attempt++) {
    const content = await storeArchiveContent(options);
    try {
      return await commitArchiveItem({
        ...options,
        content,
        createdAt: (options.now ?? (() => new Date()))(),
      });
    } catch (error) {
      if (!(error instanceof ArchiveChunksMissingError) || attempt >= ARCHIVE_COMMIT_ATTEMPTS) {
        throw error;
      }
      options.logger?.warn("archive item chunks vanished before commit; storing again", {
        itemId: options.itemId,
        missing: error.missing.length,
      });
    }
  }
}
