import { type ByteSource, damaged, u64 } from "./source.js";

/**
 * Partition tables of a guest disk: GPT (with its protective MBR) and MBR with extended
 * partitions. Read only; every entry is checked against the disk before it is used.
 */

export interface Partition {
  /** 1-based number as the guest's tools count them (logical MBR partitions from 5). */
  number: number;
  offset: number;
  size: number;
  /** GPT type GUID (upper case) or MBR type ("0x83"). */
  type: string;
  name: string | null;
}

export interface PartitionTable {
  scheme: "gpt" | "mbr";
  partitions: Partition[];
}

const SECTOR = 512;
const MAX_GPT_ENTRIES = 256;
const MAX_LOGICAL = 128;

/** GPT types that never hold a file system worth browsing. */
export const GPT_SKIP = new Set([
  "0657FD6D-A4AB-43C4-84E5-0933C84B4F4F", // Linux swap
  "21686148-6449-6E6F-744E-656564454649", // BIOS boot
  "E3C9E316-0B5C-4DB8-817D-F92DF00215AE", // Microsoft reserved
]);
export const GPT_LVM = "E6D6D379-F507-44C2-A23C-238F2A3DF928";

export function guidString(buf: Buffer, at: number): string {
  const hex = (start: number, end: number) => buf.subarray(at + start, at + end).toString("hex");
  const le = (start: number, end: number) =>
    Buffer.from(buf.subarray(at + start, at + end))
      .reverse()
      .toString("hex");
  return `${le(0, 4)}-${le(4, 6)}-${le(6, 8)}-${hex(8, 10)}-${hex(10, 16)}`.toUpperCase();
}

async function readGpt(disk: ByteSource, sector: number): Promise<PartitionTable | null> {
  if (disk.size < sector * 3) {
    return null;
  }
  const header = await disk.read(sector, Math.min(sector, 512));
  if (header.toString("latin1", 0, 8) !== "EFI PART") {
    return null;
  }
  const entriesLba = u64(header, 72);
  const count = header.readUInt32LE(80);
  const entrySize = header.readUInt32LE(84);
  if (count === 0 || count > 4096 || entrySize < 128 || entrySize > 1024 || entrySize % 8 !== 0) {
    throw damaged("the GPT header names an impossible partition array");
  }
  const used = Math.min(count, MAX_GPT_ENTRIES);
  const arrayOffset = entriesLba * sector;
  if (arrayOffset + used * entrySize > disk.size) {
    throw damaged("the GPT partition array lies outside the disk");
  }
  const array = await disk.read(arrayOffset, used * entrySize);
  const partitions: Partition[] = [];
  for (let i = 0; i < used; i++) {
    const at = i * entrySize;
    const type = guidString(array, at);
    if (type === "00000000-0000-0000-0000-000000000000") {
      continue;
    }
    const first = u64(array, at + 32);
    const last = u64(array, at + 40);
    if (last < first || (last + 1) * sector > disk.size) {
      continue;
    }
    const name = array
      .subarray(at + 56, at + 128)
      .toString("utf16le")
      .replace(/\0.*$/s, "");
    partitions.push({
      number: i + 1,
      offset: first * sector,
      size: (last - first + 1) * sector,
      type,
      name: name || null,
    });
  }
  return { scheme: "gpt", partitions };
}

interface MbrEntry {
  type: number;
  start: number;
  sectors: number;
}

function mbrEntries(sector0: Buffer): MbrEntry[] | null {
  if (sector0.readUInt16LE(510) !== 0xaa55) {
    return null;
  }
  const out: MbrEntry[] = [];
  for (let i = 0; i < 4; i++) {
    const at = 446 + i * 16;
    const status = sector0.readUInt8(at);
    if (status !== 0 && status !== 0x80) {
      return null;
    }
    out.push({
      type: sector0.readUInt8(at + 4),
      start: sector0.readUInt32LE(at + 8),
      sectors: sector0.readUInt32LE(at + 12),
    });
  }
  return out;
}

const EXTENDED = new Set([0x05, 0x0f, 0x85]);

function typeName(type: number): string {
  return `0x${type.toString(16).padStart(2, "0")}`;
}

/** Whether sector 0 looks like an MBR (and not the boot sector of a whole-disk file system). */
export function looksLikeMbr(sector0: Buffer, diskSize: number): boolean {
  const entries = mbrEntries(sector0);
  if (!entries) {
    return false;
  }
  const used = entries.filter((e) => e.type !== 0 && e.sectors > 0);
  return (
    used.length > 0 &&
    used.every((e) => e.start > 0 && (e.start + e.sectors) * SECTOR <= diskSize + 64 * SECTOR)
  );
}

async function readMbr(disk: ByteSource, sector0: Buffer): Promise<PartitionTable | null> {
  const entries = mbrEntries(sector0);
  if (!entries) {
    return null;
  }
  const partitions: Partition[] = [];
  const clamp = (start: number, sectors: number) => {
    const offset = start * SECTOR;
    const size = Math.min(sectors * SECTOR, disk.size - offset);
    return size > 0 ? { offset, size } : null;
  };
  for (const [i, entry] of entries.entries()) {
    if (entry.type === 0 || entry.sectors === 0) {
      continue;
    }
    if (EXTENDED.has(entry.type)) {
      partitions.push(...(await readLogical(disk, entry.start)));
      continue;
    }
    const place = clamp(entry.start, entry.sectors);
    if (place) {
      partitions.push({ number: i + 1, ...place, type: typeName(entry.type), name: null });
    }
  }
  return { scheme: "mbr", partitions };
}

/** The logical partitions of an extended partition (the chain of EBRs, loops refused). */
async function readLogical(disk: ByteSource, extendedStart: number): Promise<Partition[]> {
  const out: Partition[] = [];
  const seen = new Set<number>();
  let ebr = extendedStart;
  for (let n = 0; n < MAX_LOGICAL; n++) {
    if (seen.has(ebr) || (ebr + 1) * SECTOR > disk.size) {
      break;
    }
    seen.add(ebr);
    const sector = await disk.read(ebr * SECTOR, SECTOR);
    const entries = mbrEntries(sector);
    if (!entries) {
      break;
    }
    const [logical, next] = entries;
    if (logical && logical.type !== 0 && logical.sectors > 0) {
      const offset = (ebr + logical.start) * SECTOR;
      const size = Math.min(logical.sectors * SECTOR, disk.size - offset);
      if (size > 0) {
        out.push({ number: 5 + n, offset, size, type: typeName(logical.type), name: null });
      }
    }
    if (!next || next.type === 0 || next.start === 0) {
      break;
    }
    ebr = extendedStart + next.start;
  }
  return out;
}

/** The partition table of a disk, or null when it has none. */
export async function readPartitionTable(disk: ByteSource): Promise<PartitionTable | null> {
  if (disk.size < SECTOR * 2) {
    return null;
  }
  const sector0 = await disk.read(0, SECTOR);
  const entries = mbrEntries(sector0);
  if (entries?.some((e) => e.type === 0xee)) {
    const gpt = (await readGpt(disk, 512)) ?? (await readGpt(disk, 4096));
    if (gpt) {
      return gpt;
    }
  }
  if (looksLikeMbr(sector0, disk.size)) {
    return readMbr(disk, sector0);
  }
  return null;
}
