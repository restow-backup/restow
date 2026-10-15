import {
  type ByteSource,
  damaged,
  type FsEntry,
  type FsFile,
  type GuestFileSystem,
  GuestFsError,
  MAX_DIR_ENTRIES,
  pathParts,
  u64,
} from "./source.js";

/**
 * A read-only NTFS reader in user space: the boot sector, MFT records with their update
 * sequence fixups, resident and non-resident attributes with their run lists, attribute lists
 * (fragmented files), folders from $INDEX_ROOT and the in-use records of $INDEX_ALLOCATION
 * (per its $BITMAP, so deleted entries in stale index records never show), long names over DOS
 * names. Compressed and EFS-encrypted files, reparse points (symbolic links, junctions,
 * deduplicated files) and BitLocker volumes are not readable; they are listed, never followed.
 * NTFS's own journal ($LogFile) is not replayed: a restore point of a running Windows VM shows
 * the state NTFS had written to its places (Windows' VSS through the guest agent makes it
 * consistent).
 */

const ROOT_RECORD = 5;
const FIRST_USER_RECORD = 24;

const AT_STANDARD_INFORMATION = 0x10;
const AT_ATTRIBUTE_LIST = 0x20;
const AT_DATA = 0x80;
const AT_INDEX_ROOT = 0x90;
const AT_INDEX_ALLOCATION = 0xa0;
const AT_BITMAP = 0xb0;
const AT_REPARSE_POINT = 0xc0;
const AT_END = 0xffffffff;

const MAX_RUNS = 1_000_000;
const MAX_ATTRIBUTE_LIST_RECORDS = 4096;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;

/** Whether `source` holds NTFS (or a BitLocker volume, which is reported as such). */
export async function ntfsKind(source: ByteSource): Promise<"ntfs" | "bitlocker" | null> {
  if (source.size < 1024) return null;
  const boot = await source.read(0, 512);
  const oem = boot.toString("latin1", 3, 11);
  if (oem === "NTFS    ") return "ntfs";
  if (oem === "-FVE-FS-") return "bitlocker";
  return null;
}

interface Run {
  vcn: number;
  lcn: number | null; // null: sparse
  length: number;
}

interface Attribute {
  type: number;
  name: string;
  nonResident: boolean;
  flags: number;
  value: Buffer | null; // resident
  runs: Run[]; // non-resident
  startVcn: number;
  dataSize: number;
  initializedSize: number;
}

interface FileRecord {
  number: number;
  inUse: boolean;
  directory: boolean;
  attributes: Attribute[];
}

/** FILETIME (100 ns since 1601) as ISO, or null. */
function filetime(buf: Buffer, at: number): string | null {
  const ticks = buf.readBigUInt64LE(at);
  const ms = Number(ticks / 10000n) - 11644473600000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 32503680000000) return null;
  return new Date(ms).toISOString();
}

function decodeRuns(buf: Buffer, start: number, firstVcn: number): Run[] {
  const runs: Run[] = [];
  let at = start;
  let vcn = firstVcn;
  let lcn = 0;
  while (at < buf.length) {
    const header = buf.readUInt8(at);
    if (header === 0) break;
    const lengthBytes = header & 0x0f;
    const offsetBytes = header >> 4;
    if (
      lengthBytes === 0 ||
      lengthBytes > 8 ||
      offsetBytes > 8 ||
      at + 1 + lengthBytes + offsetBytes > buf.length
    ) {
      throw damaged("a damaged NTFS run list");
    }
    let length = 0;
    for (let i = lengthBytes - 1; i >= 0; i--) length = length * 256 + buf.readUInt8(at + 1 + i);
    let sparse = offsetBytes === 0;
    if (!sparse) {
      let delta = 0n;
      for (let i = offsetBytes - 1; i >= 0; i--) {
        delta = (delta << 8n) | BigInt(buf.readUInt8(at + 1 + lengthBytes + i));
      }
      if (buf.readUInt8(at + lengthBytes + offsetBytes) & 0x80) {
        delta -= 1n << BigInt(offsetBytes * 8);
      }
      lcn += Number(delta);
      if (!Number.isSafeInteger(lcn) || lcn < 0) throw damaged("an NTFS run outside the volume");
    }
    if (!Number.isSafeInteger(length) || length <= 0) throw damaged("an impossible NTFS run");
    runs.push({ vcn, lcn: sparse ? null : lcn, length });
    if (runs.length > MAX_RUNS) throw new GuestFsError("limit", "too many NTFS runs");
    vcn += length;
    at += 1 + lengthBytes + offsetBytes;
    sparse = false;
  }
  return runs;
}

export class NtfsFileSystem implements GuestFileSystem {
  readonly type = "ntfs" as const;
  label: string | null = null;
  readonly note = null;
  private clusterSize = 4096;
  private recordSize = 1024;
  private indexRecordSize = 4096;
  private sectorSize = 512;
  private mftRuns: Run[] = [];
  private records = new Map<number, FileRecord>();

  private constructor(private readonly source: ByteSource) {}

  static async open(source: ByteSource): Promise<NtfsFileSystem> {
    const fs = new NtfsFileSystem(source);
    await fs.init();
    return fs;
  }

  private async init(): Promise<void> {
    const boot = await this.source.read(0, 512);
    this.sectorSize = boot.readUInt16LE(11);
    const spcRaw = boot.readUInt8(13);
    const sectorsPerCluster = spcRaw > 0x80 ? 2 ** (256 - spcRaw) : spcRaw;
    if (![512, 1024, 2048, 4096].includes(this.sectorSize) || sectorsPerCluster === 0) {
      throw damaged("an impossible NTFS geometry");
    }
    this.clusterSize = this.sectorSize * sectorsPerCluster;
    if (this.clusterSize > 2 * 1024 * 1024) throw damaged("an impossible NTFS cluster size");
    const sized = (raw: number) => (raw >= 0x80 ? 2 ** (256 - raw) : raw * this.clusterSize);
    this.recordSize = sized(boot.readUInt8(64));
    this.indexRecordSize = sized(boot.readUInt8(68));
    if (
      this.recordSize < 512 ||
      this.recordSize > 65536 ||
      this.indexRecordSize < 512 ||
      this.indexRecordSize > 65536
    ) {
      throw damaged("an impossible NTFS record size");
    }
    const mftLcn = u64(boot, 48);
    // Record 0 is $MFT itself: its $DATA says where the rest of the MFT lies.
    const raw = await this.source.read(mftLcn * this.clusterSize, this.recordSize);
    const mft = this.parseRecord(raw, 0);
    const data = mft.attributes.find((a) => a.type === AT_DATA && a.name === "");
    if (!data?.nonResident) throw damaged("the MFT has no data runs");
    this.mftRuns = data.runs;
    // Attribute lists of $MFT itself (a very fragmented MFT) add runs from other records.
    const list = mft.attributes.find((a) => a.type === AT_ATTRIBUTE_LIST);
    if (list) {
      const full = await this.withAttributeList(mft, raw);
      const parts = full.attributes.filter((a) => a.type === AT_DATA && a.name === "");
      this.mftRuns = parts.sort((a, b) => a.startVcn - b.startVcn).flatMap((a) => a.runs);
    }
    try {
      const volume = await this.record(3);
      const name = volume.attributes.find((a) => a.type === 0x60);
      const label = name?.value?.toString("utf16le") ?? "";
      this.label = label || null;
    } catch {
      this.label = null;
    }
  }

  private fixup(buf: Buffer, what: string): Buffer {
    const usaOffset = buf.readUInt16LE(4);
    const usaCount = buf.readUInt16LE(6);
    // NTFS protects every 512 bytes, whatever the sector size.
    const stride = 512;
    if (
      usaCount === 0 ||
      usaOffset + usaCount * 2 > buf.length ||
      (usaCount - 1) * stride > buf.length
    ) {
      throw damaged(`a damaged NTFS ${what}`);
    }
    const usn = buf.readUInt16LE(usaOffset);
    for (let i = 1; i < usaCount; i++) {
      const end = i * stride - 2;
      if (end + 2 > buf.length) break;
      if (buf.readUInt16LE(end) !== usn) {
        throw damaged(`a torn NTFS ${what}`);
      }
      buf.writeUInt16LE(buf.readUInt16LE(usaOffset + i * 2), end);
    }
    return buf;
  }

  private parseRecord(raw: Buffer, number: number): FileRecord {
    const buf = Buffer.from(raw);
    if (buf.toString("latin1", 0, 4) !== "FILE") {
      throw damaged(`MFT record ${number} is damaged`);
    }
    this.fixup(buf, `MFT record ${number}`);
    const flags = buf.readUInt16LE(22);
    const used = Math.min(buf.readUInt32LE(24), buf.length);
    const attributes: Attribute[] = [];
    let at = buf.readUInt16LE(20);
    for (let n = 0; n < 512 && at + 16 <= used; n++) {
      const type = buf.readUInt32LE(at);
      if (type === AT_END) break;
      const length = buf.readUInt32LE(at + 4);
      if (length < 16 || at + length > used) break;
      const attr = buf.subarray(at, at + length);
      const nonResident = attr.readUInt8(8) === 1;
      const nameLength = attr.readUInt8(9);
      const nameOffset = attr.readUInt16LE(10);
      const name =
        nameLength > 0 && nameOffset + nameLength * 2 <= length
          ? attr.toString("utf16le", nameOffset, nameOffset + nameLength * 2)
          : "";
      const attrFlags = attr.readUInt16LE(12);
      if (nonResident) {
        if (length < 64) break;
        const startVcn = u64(attr, 16);
        attributes.push({
          type,
          name,
          nonResident,
          flags: attrFlags,
          value: null,
          runs: decodeRuns(attr, attr.readUInt16LE(32), startVcn),
          startVcn,
          dataSize: u64(attr, 48),
          initializedSize: u64(attr, 56),
        });
      } else {
        const valueLength = attr.readUInt32LE(16);
        const valueOffset = attr.readUInt16LE(20);
        if (valueOffset + valueLength > length) break;
        const value = Buffer.from(attr.subarray(valueOffset, valueOffset + valueLength));
        attributes.push({
          type,
          name,
          nonResident,
          flags: attrFlags,
          value,
          runs: [],
          startVcn: 0,
          dataSize: valueLength,
          initializedSize: valueLength,
        });
      }
      at += length;
    }
    return { number, inUse: (flags & 1) !== 0, directory: (flags & 2) !== 0, attributes };
  }

  private async readRuns(
    runs: readonly Run[],
    offset: number,
    length: number,
    limit: number,
  ): Promise<Buffer> {
    const out = Buffer.alloc(length);
    const end = Math.min(offset + length, limit);
    for (let at = offset; at < end; ) {
      const vcn = Math.floor(at / this.clusterSize);
      const run = runs.find((r) => vcn >= r.vcn && vcn < r.vcn + r.length);
      const inCluster = at % this.clusterSize;
      if (!run) {
        throw damaged("data beyond its NTFS runs");
      }
      const runEnd = (run.vcn + run.length) * this.clusterSize;
      const take = Math.min(end - at, runEnd - at, 8 * 1024 * 1024);
      if (run.lcn !== null) {
        const disk = (run.lcn + (vcn - run.vcn)) * this.clusterSize + inCluster;
        (await this.source.read(disk, take)).copy(out, at - offset);
      }
      at += take;
    }
    return out;
  }

  private async record(number: number): Promise<FileRecord> {
    const cached = this.records.get(number);
    if (cached) return cached;
    if (!Number.isSafeInteger(number) || number < 0) throw damaged("an impossible MFT reference");
    const offset = number * this.recordSize;
    const raw = await this.readRuns(this.mftRuns, offset, this.recordSize, Number.MAX_SAFE_INTEGER);
    let record = this.parseRecord(raw, number);
    if (record.attributes.some((a) => a.type === AT_ATTRIBUTE_LIST)) {
      record = await this.withAttributeList(record, raw);
    }
    if (this.records.size > 20_000) this.records.clear();
    this.records.set(number, record);
    return record;
  }

  /** A record with the attributes its attribute list keeps in other records. */
  private async withAttributeList(base: FileRecord, _raw: Buffer): Promise<FileRecord> {
    const list = base.attributes.find((a) => a.type === AT_ATTRIBUTE_LIST);
    if (!list) return base;
    const value = list.nonResident
      ? await this.readRuns(list.runs, 0, Math.min(list.dataSize, 4 * 1024 * 1024), list.dataSize)
      : (list.value as Buffer);
    const others = new Set<number>();
    for (let at = 0; at + 26 <= value.length; ) {
      const length = value.readUInt16LE(at + 4);
      if (length < 26) break;
      const ref = Number(value.readBigUInt64LE(at + 16) & 0xffffffffffffn);
      if (ref !== base.number) others.add(ref);
      at += length;
      if (others.size > MAX_ATTRIBUTE_LIST_RECORDS) break;
    }
    const attributes = base.attributes.filter((a) => a.type !== AT_ATTRIBUTE_LIST);
    for (const ref of others) {
      const offset = ref * this.recordSize;
      const raw = await this.readRuns(
        this.mftRuns,
        offset,
        this.recordSize,
        Number.MAX_SAFE_INTEGER,
      );
      try {
        attributes.push(...this.parseRecord(raw, ref).attributes);
      } catch {
        // An extension record that does not parse: its attributes are missing.
      }
    }
    return { ...base, attributes };
  }

  // --- folders ----------------------------------------------------------------------------------

  private async indexEntries(
    dir: FileRecord,
  ): Promise<{ ref: number; name: string; namespace: number; fileName: Buffer }[]> {
    const root = dir.attributes.find((a) => a.type === AT_INDEX_ROOT && a.name === "$I30");
    if (!root?.value) {
      throw new GuestFsError("not_a_directory", "not a folder");
    }
    const out: { ref: number; name: string; namespace: number; fileName: Buffer }[] = [];
    const parseNode = (buf: Buffer, nodeAt: number) => {
      const first = nodeAt + buf.readUInt32LE(nodeAt);
      const total = Math.min(nodeAt + buf.readUInt32LE(nodeAt + 4), buf.length);
      for (let at = first; at + 16 <= total; ) {
        const length = buf.readUInt16LE(at + 8);
        const keyLength = buf.readUInt16LE(at + 10);
        const flags = buf.readUInt16LE(at + 12);
        if (flags & 2) break; // the last entry carries no key
        if (length < 16 || at + length > total) break;
        if (keyLength >= 66 && at + 16 + keyLength <= total) {
          const key = buf.subarray(at + 16, at + 16 + keyLength);
          const nameLength = key.readUInt8(64);
          if (66 + nameLength * 2 <= key.length) {
            out.push({
              ref: Number(buf.readBigUInt64LE(at) & 0xffffffffffffn),
              name: key.toString("utf16le", 66, 66 + nameLength * 2),
              namespace: key.readUInt8(65),
              fileName: Buffer.from(key),
            });
            if (out.length > MAX_DIR_ENTRIES * 2) {
              throw new GuestFsError("limit", "a folder with too many entries");
            }
          }
        }
        at += length;
      }
    };
    parseNode(root.value, 16);
    const allocation = dir.attributes.filter(
      (a) => a.type === AT_INDEX_ALLOCATION && a.name === "$I30",
    );
    if (allocation.length > 0) {
      const runs = allocation.sort((a, b) => a.startVcn - b.startVcn).flatMap((a) => a.runs);
      const size = Math.max(...allocation.map((a) => a.dataSize));
      if (size > MAX_INDEX_BYTES) throw new GuestFsError("limit", "a folder index too large");
      const bitmapAttr = dir.attributes.find((a) => a.type === AT_BITMAP && a.name === "$I30");
      const bitmap = bitmapAttr
        ? bitmapAttr.nonResident
          ? await this.readRuns(
              bitmapAttr.runs,
              0,
              Math.min(bitmapAttr.dataSize, 1 << 20),
              bitmapAttr.dataSize,
            )
          : bitmapAttr.value
        : null;
      const records = Math.floor(size / this.indexRecordSize);
      for (let i = 0; i < records; i++) {
        if (bitmap && !(((bitmap[i >> 3] ?? 0) >> (i & 7)) & 1)) continue;
        const raw = await this.readRuns(runs, i * this.indexRecordSize, this.indexRecordSize, size);
        if (raw.toString("latin1", 0, 4) !== "INDX") continue;
        try {
          parseNode(this.fixup(raw, "index record"), 24);
        } catch {
          // A torn index record: its entries are missing.
        }
      }
    }
    // One entry per file: the long name over its DOS twin, and each file once.
    const best = new Map<number, (typeof out)[number]>();
    for (const entry of out) {
      if (entry.ref < FIRST_USER_RECORD && entry.ref !== ROOT_RECORD) continue;
      if (entry.ref === dir.number) continue;
      const known = best.get(entry.ref);
      if (!known || (known.namespace === 2 && entry.namespace !== 2)) {
        best.set(entry.ref, entry);
      }
    }
    return [...best.values()].slice(0, MAX_DIR_ENTRIES);
  }

  private async resolve(path: string): Promise<FileRecord | null> {
    let current = await this.record(ROOT_RECORD);
    for (const part of pathParts(path)) {
      if (!current.directory) return null;
      const lower = part.toLowerCase();
      const entries = await this.indexEntries(current);
      // NTFS names are case-insensitive for Windows: an exact match first, then any case.
      const found =
        entries.find((e) => e.name === part) ?? entries.find((e) => e.name.toLowerCase() === lower);
      if (!found) return null;
      current = await this.record(found.ref);
      if (!current.inUse) return null;
    }
    return current;
  }

  private entryOf(name: string, record: FileRecord): FsEntry {
    const info = record.attributes.find((a) => a.type === AT_STANDARD_INFORMATION)?.value;
    const mtime = info && info.length >= 16 ? filetime(info, 8) : null;
    const reparse = record.attributes.some((a) => a.type === AT_REPARSE_POINT);
    if (reparse) {
      return { name, type: "symlink", size: null, mtime };
    }
    if (record.directory) {
      return { name, type: "dir", size: null, mtime };
    }
    const data = record.attributes.filter((a) => a.type === AT_DATA && a.name === "");
    const size = data.length > 0 ? Math.max(...data.map((a) => a.dataSize)) : 0;
    return { name, type: "file", size, mtime };
  }

  async list(path: string): Promise<FsEntry[]> {
    const dir = await this.resolve(path);
    if (!dir) throw new GuestFsError("not_found", "no such folder");
    if (!dir.directory) throw new GuestFsError("not_a_directory", "not a folder");
    const out: FsEntry[] = [];
    for (const entry of await this.indexEntries(dir)) {
      try {
        const record = await this.record(entry.ref);
        if (!record.inUse) continue;
        out.push(this.entryOf(entry.name, record));
      } catch {
        out.push({ name: entry.name, type: "other", size: null, mtime: null });
      }
    }
    return out;
  }

  async stat(path: string): Promise<FsEntry | null> {
    const record = await this.resolve(path);
    if (!record) return null;
    return this.entryOf(pathParts(path).at(-1) ?? "/", record);
  }

  async open(path: string): Promise<FsFile> {
    const record = await this.resolve(path);
    if (!record) throw new GuestFsError("not_found", "no such file");
    const entry = this.entryOf("", record);
    if (entry.type !== "file") throw new GuestFsError("not_a_file", "not a regular file");
    const parts = record.attributes
      .filter((a) => a.type === AT_DATA && a.name === "")
      .sort((a, b) => a.startVcn - b.startVcn);
    const first = parts[0];
    if (!first) {
      return { size: 0, read: async () => Buffer.alloc(0) };
    }
    if (parts.some((a) => a.flags & 0x0001)) {
      throw new GuestFsError("unsupported", "the file is NTFS-compressed");
    }
    if (parts.some((a) => a.flags & 0x4000)) {
      throw new GuestFsError("unsupported", "the file is EFS-encrypted");
    }
    if (!first.nonResident) {
      const value = first.value as Buffer;
      return {
        size: value.length,
        read: async (offset, length) => Buffer.from(value.subarray(offset, offset + length)),
      };
    }
    const runs = parts.flatMap((a) => a.runs);
    const size = first.dataSize;
    const initialized = first.initializedSize;
    return {
      size,
      read: async (offset, length) => {
        const end = Math.min(size, offset + length);
        if (end <= offset) return Buffer.alloc(0);
        const out = Buffer.alloc(end - offset);
        // Beyond the initialized size the file reads as zeros.
        const real = Math.min(end, initialized);
        if (real > offset) {
          (await this.readRuns(runs, offset, real - offset, real)).copy(out, 0);
        }
        return out;
      },
    };
  }
}
