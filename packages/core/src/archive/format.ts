/**
 * On-disk serialization of an {@link ArchiveItemRecord}: sealed the same way
 * every snapshot manifest is (engine/sealed-manifest.ts), because an archive
 * item's record carries exactly the kind of content a manifest does —
 * subjects, addresses, the item's own plaintext hash — and must be no more
 * readable to a storage-target operator than a manifest is. See FORMAT.md for
 * the full on-disk layout this is part of.
 *
 * Layout:
 *   codec tag 0x01 (1) | sealed blob (crypto.ts layout)
 * The sealed blob is AES-256-GCM under the tenant's current DEK; its
 * plaintext is the JSON below, and its AAD is the UTF-8 storage key the
 * record is written under (`tenants/<tid>/archive/<year>/<month>/<id>.json`),
 * exactly as sealed-manifest.ts binds a manifest to its key. A record copied
 * to another key, or read back under the wrong tenant, does not open.
 */
import { type Dek, encryptChunk } from "../crypto.js";
import { sealedAad } from "../engine/keyring.js";
import type { JournalEnvelope } from "./journal.js";
import { archiveItemKey } from "./layout.js";
import type { ArchiveItemRecord } from "./types.js";

/** Codec tag of a sealed archive item record. */
export const ARCHIVE_ITEM_CODEC = 0x01;

/** The JSON shape a record serializes to (dates as ISO strings). */
interface ArchiveItemJson {
  readonly id: string;
  readonly tenantId: string;
  readonly receivedAt: string;
  readonly itemHash: string;
  readonly prevChainHash: string | null;
  readonly chainHash: string;
  readonly size: number;
  readonly chunks: readonly string[];
  readonly envelope: JournalEnvelope | null;
  readonly flags: readonly string[];
  readonly source: string;
  readonly legalHold: boolean;
  readonly retentionUntil: string | null;
  readonly createdAt: string;
}

/** Serialize a record to its unsealed plaintext JSON bytes. */
export function serializeArchiveItem(record: ArchiveItemRecord): Buffer {
  const json: ArchiveItemJson = {
    id: record.id,
    tenantId: record.tenantId,
    receivedAt: record.receivedAt.toISOString(),
    itemHash: record.itemHash,
    prevChainHash: record.prevChainHash,
    chainHash: record.chainHash,
    size: record.size,
    chunks: record.chunks,
    envelope: record.envelope,
    flags: record.flags,
    source: record.source,
    legalHold: record.legalHold,
    retentionUntil: record.retentionUntil ? record.retentionUntil.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
  };
  return Buffer.from(JSON.stringify(json), "utf8");
}

/** Parse a record's unsealed plaintext JSON bytes back into an {@link ArchiveItemRecord}. */
export function deserializeArchiveItem(bytes: Buffer): ArchiveItemRecord {
  const json = JSON.parse(bytes.toString("utf8")) as ArchiveItemJson;
  return {
    id: json.id,
    tenantId: json.tenantId,
    receivedAt: new Date(json.receivedAt),
    itemHash: json.itemHash,
    prevChainHash: json.prevChainHash,
    chainHash: json.chainHash,
    size: json.size,
    chunks: json.chunks,
    envelope: json.envelope,
    flags: json.flags as ArchiveItemRecord["flags"],
    source: json.source as ArchiveItemRecord["source"],
    legalHold: json.legalHold,
    retentionUntil: json.retentionUntil ? new Date(json.retentionUntil) : null,
    createdAt: new Date(json.createdAt),
  };
}

/** Serialize and seal a record with the tenant DEK, bound to the storage key it is written under. */
export function sealArchiveItem(record: ArchiveItemRecord, key: Dek, storageKey: string): Buffer {
  const plaintext = serializeArchiveItem(record);
  const sealed = encryptChunk(key, plaintext, Buffer.from(storageKey, "utf8"));
  return Buffer.concat([Buffer.from([ARCHIVE_ITEM_CODEC]), sealed]);
}

/** Whether serialized bytes are a sealed archive item (as opposed to, say, garbage or another codec). */
export function isSealedArchiveItem(bytes: Buffer): boolean {
  return bytes.length > 0 && bytes[0] === ARCHIVE_ITEM_CODEC;
}

/** The storage key a sealed record is bound to, read from its header without any key. */
export function sealedArchiveItemKey(bytes: Buffer): string {
  if (!isSealedArchiveItem(bytes)) {
    throw new Error("bytes are not a sealed archive item");
  }
  return sealedAad(bytes.subarray(1)).toString("utf8");
}

export interface OpenArchiveItemOptions {
  /** Opens the sealed blob with the tenant key. */
  readonly open: (sealed: Buffer) => Buffer;
  /** The storage key the bytes were read from, when known. A record bound to another key is refused. */
  readonly storageKey?: string;
}

/**
 * Decode a stored archive item: opened with `options.open` and checked
 * against `options.storageKey` when given. Throws on anything that is not a
 * sealed archive item, on a key mismatch, or on a record whose own `id` and
 * `tenantId` do not match what the storage key names.
 */
export function openArchiveItem(bytes: Buffer, options: OpenArchiveItemOptions): ArchiveItemRecord {
  if (!isSealedArchiveItem(bytes)) {
    throw new Error(
      "archive item is not sealed; refusing to trust unencrypted content from storage",
    );
  }
  const boundTo = sealedArchiveItemKey(bytes);
  if (options.storageKey !== undefined && options.storageKey !== boundTo) {
    throw new Error(`archive item is bound to ${boundTo}, not to ${options.storageKey}`);
  }
  const plaintext = options.open(bytes.subarray(1));
  const record = deserializeArchiveItem(plaintext);
  // The key names the tenant, date bucket and item id, and it is authenticated
  // along with the content (it is the GCM AAD), so the two must agree.
  if (archiveItemKey(record.tenantId, record.receivedAt, record.id) !== boundTo) {
    throw new Error(`archive item content does not belong to ${boundTo}`);
  }
  return record;
}
