/**
 * Pack files: the on-disk container for sealed chunks.
 *
 * A pack holds many already-sealed chunks back to back, followed by an index and
 * a fixed-size footer. The format is open and documented so a standalone restore
 * (packages/cli) can read it without a running server. See docs/ARCHITECTURE.md.
 *
 * File layout (all integers big-endian):
 *   header   : magic "RESTOWPK" (8) | format version (2) | tenant id length (2) |
 *              tenant id (UTF-8)
 *   body     : sealed chunk bytes, concatenated
 *   index    : per chunk -> storedId length (1) | storedId | offset (8) | length (4)
 *   footer   : index offset (8) | index length (4) | chunk count (4) |
 *              content SHA-256 (32) | trailer magic "RSPKEND\0" (8)
 *
 * The content hash covers every byte before it (header + body + index + the first
 * 16 footer bytes), giving whole-file integrity for the scrub job.
 */
import { sha256 } from "./crypto.js";

/** Magic marker at the start of a pack file. */
export const PACK_MAGIC = Buffer.from("RESTOWPK", "ascii");
/** Magic marker at the very end of a pack file. */
export const PACK_TRAILER_MAGIC = Buffer.from("RSPKEND\0", "ascii");
/** On-disk pack format version. */
export const PACK_FORMAT_VERSION = 1;

const FOOTER_HEAD_LENGTH = 8 + 4 + 4; // index offset + index length + chunk count
const HASH_LENGTH = 32;
const FOOTER_LENGTH = FOOTER_HEAD_LENGTH + HASH_LENGTH + PACK_TRAILER_MAGIC.length;

/** An index entry: which chunk lives where inside the pack. */
export interface PackEntry {
  /** Tenant-scoped stored id (see chunkId.storedId). */
  readonly storedId: Buffer;
  /** Byte offset of the sealed chunk within the pack file. */
  readonly offset: number;
  /** Byte length of the sealed chunk. */
  readonly length: number;
}

function hex(id: Buffer): string {
  return id.toString("hex");
}

function buildHeader(tenantId: string, version: number): Buffer {
  const idBytes = Buffer.from(tenantId, "utf8");
  if (idBytes.length > 0xffff) {
    throw new RangeError(`tenant id is too long (${idBytes.length} bytes)`);
  }
  const header = Buffer.alloc(PACK_MAGIC.length + 2 + 2 + idBytes.length);
  let offset = PACK_MAGIC.copy(header, 0);
  offset = header.writeUInt16BE(version, offset);
  offset = header.writeUInt16BE(idBytes.length, offset);
  idBytes.copy(header, offset);
  return header;
}

/**
 * Assembles a pack file in memory. Callers append sealed chunks (a pack is capped
 * at ~64 MiB by the caller) and then {@link finalize} to obtain the bytes to write.
 */
export class PackWriter {
  private readonly header: Buffer;
  private readonly chunks: Buffer[] = [];
  private readonly indexEntries: PackEntry[] = [];
  /** Entries by hex stored id: a pack holds every chunk at most once. */
  private readonly byId = new Map<string, PackEntry>();
  private bodyLength = 0;

  constructor(
    readonly tenantId: string,
    readonly version: number = PACK_FORMAT_VERSION,
  ) {
    this.header = buildHeader(tenantId, version);
  }

  /** Number of chunks appended so far. */
  get count(): number {
    return this.indexEntries.length;
  }

  /** Current size of header + body, i.e. the pack size before the index/footer. */
  get byteLength(): number {
    return this.header.length + this.bodyLength;
  }

  /** Whether a chunk with this stored id was already appended. */
  has(storedId: Buffer): boolean {
    return this.byId.has(hex(storedId));
  }

  /**
   * Append one already-sealed chunk. Returns its index entry. A stored id that
   * is already in the pack is not appended again: the entry it has is returned,
   * so the pack index never names one id twice.
   */
  append(storedId: Buffer, sealedChunk: Buffer): PackEntry {
    const key = hex(storedId);
    const present = this.byId.get(key);
    if (present) {
      return present;
    }
    const entry: PackEntry = {
      storedId: Buffer.from(storedId),
      offset: this.header.length + this.bodyLength,
      length: sealedChunk.length,
    };
    this.chunks.push(sealedChunk);
    this.indexEntries.push(entry);
    this.byId.set(key, entry);
    this.bodyLength += sealedChunk.length;
    return entry;
  }

  private buildIndex(): Buffer {
    const parts: Buffer[] = [];
    for (const entry of this.indexEntries) {
      const record = Buffer.alloc(1 + entry.storedId.length + 8 + 4);
      let offset = record.writeUInt8(entry.storedId.length, 0);
      offset += entry.storedId.copy(record, offset);
      offset = record.writeBigUInt64BE(BigInt(entry.offset), offset);
      record.writeUInt32BE(entry.length, offset);
      parts.push(record);
    }
    return Buffer.concat(parts);
  }

  /** Produce the complete pack file bytes. */
  finalize(): Buffer {
    const index = this.buildIndex();
    const indexOffset = this.header.length + this.bodyLength;

    const footerHead = Buffer.alloc(FOOTER_HEAD_LENGTH);
    let offset = footerHead.writeBigUInt64BE(BigInt(indexOffset), 0);
    offset = footerHead.writeUInt32BE(index.length, offset);
    footerHead.writeUInt32BE(this.indexEntries.length, offset);

    const hashed = Buffer.concat([this.header, ...this.chunks, index, footerHead]);
    const contentHash = sha256(hashed);
    return Buffer.concat([hashed, contentHash, PACK_TRAILER_MAGIC]);
  }
}

/** Reads a pack file assembled by {@link PackWriter}. */
export class PackReader {
  private constructor(
    private readonly file: Buffer,
    readonly tenantId: string,
    readonly version: number,
    private readonly index: Map<string, PackEntry>,
  ) {}

  /**
   * Parse a pack file. When `verify` is set (the default), the whole-file hash is
   * recomputed and a mismatch throws.
   */
  static open(file: Buffer, options: { verify?: boolean } = {}): PackReader {
    const verify = options.verify ?? true;
    if (file.length < PACK_MAGIC.length + 4 + FOOTER_LENGTH) {
      throw new Error("pack file is too small");
    }
    if (!file.subarray(0, PACK_MAGIC.length).equals(PACK_MAGIC)) {
      throw new Error("pack file has a bad magic marker");
    }
    if (!file.subarray(file.length - PACK_TRAILER_MAGIC.length).equals(PACK_TRAILER_MAGIC)) {
      throw new Error("pack file has a bad trailer marker");
    }

    const footerHeadStart = file.length - FOOTER_LENGTH;
    const hashStart = footerHeadStart + FOOTER_HEAD_LENGTH;
    const indexOffset = Number(file.readBigUInt64BE(footerHeadStart));
    const indexLength = file.readUInt32BE(footerHeadStart + 8);
    const chunkCount = file.readUInt32BE(footerHeadStart + 12);
    const storedHash = file.subarray(hashStart, hashStart + HASH_LENGTH);

    if (verify) {
      const actual = sha256(file.subarray(0, hashStart));
      if (!actual.equals(storedHash)) {
        throw new Error("pack file failed integrity check (content hash mismatch)");
      }
    }

    // Header: version + tenant id.
    let offset = PACK_MAGIC.length;
    const version = file.readUInt16BE(offset);
    offset += 2;
    const tenantIdLength = file.readUInt16BE(offset);
    offset += 2;
    const tenantId = file.subarray(offset, offset + tenantIdLength).toString("utf8");

    // Index.
    if (indexOffset + indexLength > footerHeadStart) {
      throw new Error("pack index bounds are invalid");
    }
    const index = new Map<string, PackEntry>();
    let cursor = indexOffset;
    const indexEnd = indexOffset + indexLength;
    for (let i = 0; i < chunkCount; i++) {
      if (cursor + 1 > indexEnd) {
        throw new Error("pack index is truncated");
      }
      const idLength = file.readUInt8(cursor);
      cursor += 1;
      const idEnd = cursor + idLength;
      const entryEnd = idEnd + 8 + 4;
      if (entryEnd > indexEnd) {
        throw new Error("pack index entry is truncated");
      }
      const id = Buffer.from(file.subarray(cursor, idEnd));
      const entryOffset = Number(file.readBigUInt64BE(idEnd));
      const entryLength = file.readUInt32BE(idEnd + 8);
      // Packs written before duplicate ids were refused can name an id twice.
      // The first entry wins, as it does in the chunk index (the first row
      // recorded for an id is kept).
      const key = hex(id);
      if (!index.has(key)) {
        index.set(key, { storedId: id, offset: entryOffset, length: entryLength });
      }
      cursor = entryEnd;
    }

    return new PackReader(file, tenantId, version, index);
  }

  /** Number of chunks in the pack. */
  get count(): number {
    return this.index.size;
  }

  /** Whether a chunk with this stored id is present. */
  has(storedId: Buffer): boolean {
    return this.index.has(hex(storedId));
  }

  /** Get a sealed chunk's bytes by stored id, or `undefined` if absent. */
  get(storedId: Buffer): Buffer | undefined {
    const entry = this.index.get(hex(storedId));
    if (!entry) {
      return undefined;
    }
    return Buffer.from(this.file.subarray(entry.offset, entry.offset + entry.length));
  }

  /** All index entries, in stored order. */
  entries(): PackEntry[] {
    return [...this.index.values()];
  }

  /** Recompute and check the whole-file content hash. */
  verify(): boolean {
    const hashStart = this.file.length - FOOTER_LENGTH + FOOTER_HEAD_LENGTH;
    const actual = sha256(this.file.subarray(0, hashStart));
    return actual.equals(this.file.subarray(hashStart, hashStart + HASH_LENGTH));
  }
}
