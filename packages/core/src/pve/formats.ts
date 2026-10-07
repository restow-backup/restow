/**
 * Binary formats of VM disk backups from Proxmox VE (docs/PROXMOX.md 2.4,
 * docs/PVE-PROTOCOL.md). The node helper restow-pve speaks the first three;
 * its Go side is agent/internal/pve/formats.go and both must change together.
 *
 *   upload frame  "RSBF" | version 1 | count u16 | per block:
 *                 nameLen u8 | device | index u32 | flags u8 | length u32 | sha256[32] | data
 *                 (flags bit 0 = zero block, which carries no data)
 *   hash list     "RSBH" | version 1 | blockSize u32 | diskSize u64 | blockCount u32 |
 *                 per block: flags u8 (1 zero, 2 present) | sha256[32]
 *   restore block index u32 | flags u8 | length u32 | data (absent for zero blocks)
 *
 * and the stored block map, an object in the chunk store (never sent to a node):
 *
 *   block map     "RSBM" | version 1 | blockSize u32 | diskSize u64 | blockCount u32 |
 *                 chunkCount u32 | chunk ids (chunkCount x 32 bytes, first use order) |
 *                 per block: flags u8 | sha256[32] | first reference u32 | reference count u16 |
 *                 referenceCount u32 | references (u32 positions in the chunk id list)
 *
 * Every block map lists every block of the disk, so each restore point is a
 * synthetic full: no restore point needs another one to be read.
 * Integers are big endian.
 */
import { createHash } from "node:crypto";

/** 4 MiB, the granularity of the QEMU dirty bitmap PVE sets up. */
export const PVE_BLOCK_SIZE = 4 * 1024 * 1024;
export const MAX_BLOCKS_PER_FRAME = 16;
export const BLOCK_FLAG_ZERO = 1;
export const BLOCK_FLAG_PRESENT = 2;

const FRAME_MAGIC = Buffer.from("RSBF");
const HASHES_MAGIC = Buffer.from("RSBH");
const MAP_MAGIC = Buffer.from("RSBM");
const RECORD_BYTES = 39;

export class PveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PveFormatError";
  }
}

export function blockCount(diskSize: number): number {
  return Math.ceil(diskSize / PVE_BLOCK_SIZE);
}

/** Length of block `index` of a disk (the last block may be short). */
export function blockLength(diskSize: number, index: number): number {
  const start = index * PVE_BLOCK_SIZE;
  if (start >= diskSize) {
    return 0;
  }
  return Math.min(PVE_BLOCK_SIZE, diskSize - start);
}

export interface FrameBlock {
  device: string;
  index: number;
  zero: boolean;
  length: number;
  /** Hex SHA-256 the node claims for the plaintext (zero blocks: all zeros). */
  sha256: string;
  data: Buffer | null;
}

/** Decode an upload frame. Throws PveFormatError on anything malformed. */
export function decodeFrame(buf: Buffer): FrameBlock[] {
  if (buf.length < 7 || !buf.subarray(0, 4).equals(FRAME_MAGIC) || buf[4] !== 1) {
    throw new PveFormatError("not a block frame");
  }
  const count = buf.readUInt16BE(5);
  if (count < 1 || count > MAX_BLOCKS_PER_FRAME) {
    throw new PveFormatError(`a frame holds 1 to ${MAX_BLOCKS_PER_FRAME} blocks`);
  }
  const out: FrameBlock[] = [];
  let at = 7;
  for (let i = 0; i < count; i++) {
    if (at + 1 > buf.length) {
      throw new PveFormatError("frame cut short");
    }
    const nameLength = buf[at] as number;
    at += 1;
    if (nameLength < 1 || nameLength > 64 || at + nameLength + 41 > buf.length) {
      throw new PveFormatError("frame cut short");
    }
    const device = buf.subarray(at, at + nameLength).toString("utf8");
    at += nameLength;
    const index = buf.readUInt32BE(at);
    const flags = buf[at + 4] as number;
    const length = buf.readUInt32BE(at + 5);
    const sha256 = buf.subarray(at + 9, at + 41).toString("hex");
    at += 41;
    if (length < 1 || length > PVE_BLOCK_SIZE) {
      throw new PveFormatError(`block ${index}: invalid length ${length}`);
    }
    const zero = (flags & BLOCK_FLAG_ZERO) !== 0;
    let data: Buffer | null = null;
    if (!zero) {
      if (at + length > buf.length) {
        throw new PveFormatError("frame cut short");
      }
      data = buf.subarray(at, at + length);
      at += length;
    }
    out.push({ device, index, zero, length, sha256, data });
  }
  if (at !== buf.length) {
    throw new PveFormatError("trailing bytes after the last block");
  }
  return out;
}

/** Encode an upload frame (tests; the node encodes in Go). */
export function encodeFrame(blocks: readonly FrameBlock[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(7);
  FRAME_MAGIC.copy(head, 0);
  head[4] = 1;
  head.writeUInt16BE(blocks.length, 5);
  parts.push(head);
  for (const b of blocks) {
    const name = Buffer.from(b.device, "utf8");
    const fixed = Buffer.alloc(1 + name.length + 41);
    fixed[0] = name.length;
    name.copy(fixed, 1);
    let at = 1 + name.length;
    fixed.writeUInt32BE(b.index, at);
    fixed[at + 4] = b.zero ? BLOCK_FLAG_ZERO : 0;
    fixed.writeUInt32BE(b.length, at + 5);
    Buffer.from(b.sha256, "hex").copy(fixed, at + 9);
    at += 41;
    parts.push(fixed);
    if (!b.zero && b.data) {
      parts.push(b.data);
    }
  }
  return Buffer.concat(parts);
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** One block of a map. `chunks` are stored chunk ids (hex); empty for a zero block. */
export interface MapEntry {
  flags: number;
  /** Hex SHA-256 of the plaintext block; all zeros for a zero block. */
  sha256: string;
  chunks: string[];
}

export interface BlockMap {
  diskSize: number;
  entries: MapEntry[];
}

const ZERO_HASH = "0".repeat(64);

export function zeroEntry(): MapEntry {
  return { flags: BLOCK_FLAG_ZERO, sha256: ZERO_HASH, chunks: [] };
}

/** A map of a disk that holds only zeroes. */
export function emptyBlockMap(diskSize: number): BlockMap {
  return { diskSize, entries: Array.from({ length: blockCount(diskSize) }, zeroEntry) };
}

function header(magic: Buffer, diskSize: number, count: number, extra: number): Buffer {
  const head = Buffer.alloc(21 + extra);
  magic.copy(head, 0);
  head[4] = 1;
  head.writeUInt32BE(PVE_BLOCK_SIZE, 5);
  head.writeBigUInt64BE(BigInt(diskSize), 9);
  head.writeUInt32BE(count, 17);
  return head;
}

function readHeader(buf: Buffer, magic: Buffer, what: string): { diskSize: number; count: number } {
  if (buf.length < 21 || !buf.subarray(0, 4).equals(magic) || buf[4] !== 1) {
    throw new PveFormatError(`not a ${what}`);
  }
  if (buf.readUInt32BE(5) !== PVE_BLOCK_SIZE) {
    throw new PveFormatError(`${what} with another block size`);
  }
  const diskSize = Number(buf.readBigUInt64BE(9));
  const count = buf.readUInt32BE(17);
  if (count !== blockCount(diskSize)) {
    throw new PveFormatError(`${what} is inconsistent`);
  }
  return { diskSize, count };
}

/** Encode the stored form of a block map. */
export function encodeBlockMap(map: BlockMap): Buffer {
  if (map.entries.length !== blockCount(map.diskSize)) {
    throw new PveFormatError("block map does not cover the disk");
  }
  const ids: string[] = [];
  const position = new Map<string, number>();
  for (const entry of map.entries) {
    for (const id of entry.chunks) {
      if (!position.has(id)) {
        position.set(id, ids.length);
        ids.push(id);
      }
    }
  }
  const head = header(MAP_MAGIC, map.diskSize, map.entries.length, 4);
  head.writeUInt32BE(ids.length, 21);
  const table = Buffer.alloc(ids.length * 32);
  ids.forEach((id, i) => {
    const raw = Buffer.from(id, "hex");
    if (raw.length !== 32) {
      throw new PveFormatError(`chunk id ${id} is not 32 bytes`);
    }
    raw.copy(table, i * 32);
  });
  // Records point into a flat list of chunk references; consecutive blocks
  // with their own chunks reference consecutive runs.
  const refs: number[] = [];
  const records = Buffer.alloc(map.entries.length * RECORD_BYTES);
  map.entries.forEach((entry, i) => {
    const at = i * RECORD_BYTES;
    records[at] = entry.flags;
    Buffer.from(entry.sha256, "hex").copy(records, at + 1);
    records.writeUInt32BE(refs.length, at + 33);
    records.writeUInt16BE(entry.chunks.length, at + 37);
    for (const id of entry.chunks) {
      refs.push(position.get(id) as number);
    }
  });
  const refTable = Buffer.alloc(4 + refs.length * 4);
  refTable.writeUInt32BE(refs.length, 0);
  refs.forEach((r, i) => refTable.writeUInt32BE(r, 4 + i * 4));
  return Buffer.concat([head, table, records, refTable]);
}

/** Decode a stored block map. */
export function decodeBlockMap(buf: Buffer): BlockMap {
  const { diskSize, count } = readHeader(buf, MAP_MAGIC, "block map");
  if (buf.length < 25) {
    throw new PveFormatError("block map cut short");
  }
  const idCount = buf.readUInt32BE(21);
  let at = 25;
  const recordsAt = at + idCount * 32;
  const refsAt = recordsAt + count * RECORD_BYTES;
  if (buf.length < refsAt + 4) {
    throw new PveFormatError("block map cut short");
  }
  const ids: string[] = [];
  for (let i = 0; i < idCount; i++, at += 32) {
    ids.push(buf.subarray(at, at + 32).toString("hex"));
  }
  const refCount = buf.readUInt32BE(refsAt);
  if (buf.length !== refsAt + 4 + refCount * 4) {
    throw new PveFormatError("block map has a wrong length");
  }
  const entries: MapEntry[] = [];
  for (let i = 0; i < count; i++) {
    const r = recordsAt + i * RECORD_BYTES;
    const first = buf.readUInt32BE(r + 33);
    const n = buf.readUInt16BE(r + 37);
    if (first + n > refCount) {
      throw new PveFormatError(`block ${i} points outside the chunk list`);
    }
    const chunks: string[] = [];
    for (let k = 0; k < n; k++) {
      const ref = buf.readUInt32BE(refsAt + 4 + (first + k) * 4);
      const id = ids[ref];
      if (id === undefined) {
        throw new PveFormatError(`block ${i} names an unknown chunk`);
      }
      chunks.push(id);
    }
    entries.push({
      flags: buf[r] as number,
      sha256: buf.subarray(r + 1, r + 33).toString("hex"),
      chunks,
    });
  }
  return { diskSize, entries };
}

/** The hash list a node keeps of a map (what it compares blocks against). */
export function encodeHashList(map: BlockMap): Buffer {
  const head = header(HASHES_MAGIC, map.diskSize, map.entries.length, 0);
  const body = Buffer.alloc(map.entries.length * 33);
  map.entries.forEach((entry, i) => {
    body[i * 33] = entry.flags & (BLOCK_FLAG_ZERO | BLOCK_FLAG_PRESENT);
    Buffer.from(entry.sha256, "hex").copy(body, i * 33 + 1);
  });
  return Buffer.concat([head, body]);
}

/** The digest of a map's hash list, which the node compares with its cache. */
export function hashListDigest(map: BlockMap): string {
  return sha256Hex(encodeHashList(map));
}

/** Encode one block of a restore stream. */
export function encodeRestoreBlock(index: number, length: number, data: Buffer | null): Buffer {
  const head = Buffer.alloc(9);
  head.writeUInt32BE(index, 0);
  head[4] = data ? 0 : BLOCK_FLAG_ZERO;
  head.writeUInt32BE(length, 5);
  return data ? Buffer.concat([head, data]) : head;
}

/** The distinct stored chunk ids a map references (its blocks, not the map object itself). */
export function mapChunkIds(map: BlockMap): string[] {
  const seen = new Set<string>();
  for (const entry of map.entries) {
    for (const id of entry.chunks) {
      seen.add(id);
    }
  }
  return [...seen];
}
