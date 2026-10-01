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
 * `prevChainHash` (ARCHIVE-JOURNAL's receiver does this against Postgres, so
 * the lookup and the append are atomic; nothing here could make that
 * guarantee on its own).
 */
import type { ObjectInput } from "../engine/chunkstore.js";
import { ChunkWriter } from "../engine/chunkstore.js";
import type { ChunkIndex, Logger, StorageTargets, TenantKeyring } from "../engine/types.js";
import type { PutOptions } from "../storage/backend.js";
import { computeArchiveChainHash } from "./chain.js";
import { sealArchiveItem } from "./format.js";
import type { JournalEnvelope, JournalFlag } from "./journal.js";
import { archiveItemKey } from "./layout.js";
import { type RetentionPolicy, retentionUntil } from "./retention.js";
import type { ArchiveItemRecord, ArchiveSource } from "./types.js";

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
  readonly flags: readonly JournalFlag[];
  readonly source: ArchiveSource;
  readonly retentionPolicy: RetentionPolicy;
  readonly legalHold?: boolean;
  /** The tenant chain's current last chain hash (from `ArchiveCatalog.lastChainHash`), or null for the first item. */
  readonly prevChainHash: string | null;
  readonly now?: () => Date;
  readonly logger?: Logger;
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
 * Write one archived item: chunk, dedupe and seal the original bytes into
 * the pack store, then write its sealed record. Returns the record the
 * caller must append to the {@link ArchiveCatalog}.
 */
export async function writeArchiveItem(
  options: WriteArchiveItemOptions,
): Promise<ArchiveItemRecord> {
  const itemKey = archiveItemKey(options.tenantId, options.receivedAt, options.itemId);
  const existing = await options.storage.primary.head(itemKey);
  if (existing) {
    throw new ArchiveWriteOnceError(itemKey);
  }

  const writer = new ChunkWriter({
    tenantId: options.tenantId,
    storage: options.storage,
    keys: options.keys,
    index: options.index,
    logger: options.logger,
  });
  const written = await writer.write(options.original);
  await writer.close();
  // Pin the chunks this item needs: without a reference, scrub GC treats
  // them as unreferenced (no backup shares them) and reclaims them after its
  // grace period, which would silently break restore of this item later.
  await options.index.addReferences(written.chunks);

  const chainHash = computeArchiveChainHash(
    options.prevChainHash,
    written.sha256,
    options.receivedAt,
  );
  const retentionUntilDate = retentionUntil(options.receivedAt, options.retentionPolicy);
  const now = (options.now ?? (() => new Date()))();

  const record: ArchiveItemRecord = {
    id: options.itemId,
    tenantId: options.tenantId,
    receivedAt: options.receivedAt,
    itemHash: written.sha256,
    prevChainHash: options.prevChainHash,
    chainHash,
    size: written.size,
    chunks: written.chunks,
    envelope: options.envelope,
    flags: [...options.flags],
    source: options.source,
    legalHold: options.legalHold ?? false,
    retentionUntil: retentionUntilDate,
    createdAt: now,
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
