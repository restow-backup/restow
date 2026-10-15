import {
  type ByteSource,
  damaged,
  type FsEntry,
  type FsFile,
  type GuestFileSystem,
  GuestFsError,
  MAX_DIR_ENTRIES,
  pathParts,
} from "./source.js";

/**
 * A read-only reader of FAT12, FAT16 and FAT32 (the EFI system partition of almost every VM,
 * and small data volumes): the BIOS parameter block, the first FAT, cluster chains (loops and
 * chains longer than the volume refused) and long file names.
 */

interface FatEntry extends FsEntry {
  cluster: number;
}

/** Whether `source` holds a FAT file system. */
export async function isFat(source: ByteSource): Promise<boolean> {
  if (source.size < 4096) return false;
  const boot = await source.read(0, 512);
  if (boot.readUInt16LE(510) !== 0xaa55) return false;
  const bytesPerSector = boot.readUInt16LE(11);
  const spc = boot.readUInt8(13);
  const fats = boot.readUInt8(16);
  const type16 = boot.toString("latin1", 54, 59);
  const type32 = boot.toString("latin1", 82, 87);
  return (
    [512, 1024, 2048, 4096].includes(bytesPerSector) &&
    spc > 0 &&
    (spc & (spc - 1)) === 0 &&
    fats >= 1 &&
    fats <= 4 &&
    boot.readUInt16LE(14) > 0 &&
    (type16 === "FAT12" || type16 === "FAT16" || type16 === "FAT  " || type32 === "FAT32")
  );
}

function dosTime(date: number, time: number): string | null {
  if (date === 0) return null;
  const year = 1980 + (date >> 9);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  if (month < 1 || month > 12 || day < 1) return null;
  const d = new Date(
    Date.UTC(year, month - 1, day, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2),
  );
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export class FatFileSystem implements GuestFileSystem {
  readonly type = "vfat" as const;
  label: string | null = null;
  readonly note = null;
  private bytesPerSector = 512;
  private clusterSize = 512;
  private fatOffset = 0;
  private fatBytes = 0;
  private rootOffset = 0;
  private rootEntries = 0;
  private rootCluster = 0;
  private dataOffset = 0;
  private clusters = 0;
  private bits: 12 | 16 | 32 = 16;
  private fat: Buffer | null = null;

  private constructor(private readonly source: ByteSource) {}

  static async open(source: ByteSource): Promise<FatFileSystem> {
    const fs = new FatFileSystem(source);
    await fs.init();
    return fs;
  }

  private async init(): Promise<void> {
    const boot = await this.source.read(0, 512);
    this.bytesPerSector = boot.readUInt16LE(11);
    this.clusterSize = this.bytesPerSector * boot.readUInt8(13);
    const reserved = boot.readUInt16LE(14);
    const fats = boot.readUInt8(16);
    this.rootEntries = boot.readUInt16LE(17);
    const total16 = boot.readUInt16LE(19);
    const fatSize16 = boot.readUInt16LE(22);
    const total = total16 || boot.readUInt32LE(32);
    const fatSectors = fatSize16 || boot.readUInt32LE(36);
    const rootSectors = Math.ceil((this.rootEntries * 32) / this.bytesPerSector);
    this.fatOffset = reserved * this.bytesPerSector;
    this.fatBytes = fatSectors * this.bytesPerSector;
    this.rootOffset = this.fatOffset + fats * this.fatBytes;
    this.dataOffset = this.rootOffset + rootSectors * this.bytesPerSector;
    const dataSectors = total - this.dataOffset / this.bytesPerSector;
    this.clusters = Math.floor(dataSectors / (this.clusterSize / this.bytesPerSector));
    if (
      this.clusters <= 0 ||
      this.dataOffset > this.source.size ||
      this.fatBytes > 64 * 1024 * 1024
    ) {
      throw damaged("an impossible FAT geometry");
    }
    this.bits = this.clusters < 4085 ? 12 : this.clusters < 65525 ? 16 : 32;
    if (this.bits === 32) {
      this.rootCluster = boot.readUInt32LE(44);
    }
    const labelAt = this.bits === 32 ? 71 : 43;
    const label = boot.toString("latin1", labelAt, labelAt + 11).trim();
    this.label = label && label !== "NO NAME" ? label : null;
    this.fat = await this.source.read(
      this.fatOffset,
      Math.min(this.fatBytes, this.source.size - this.fatOffset),
    );
  }

  private next(cluster: number): number {
    const fat = this.fat as Buffer;
    if (this.bits === 32) {
      return cluster * 4 + 4 <= fat.length
        ? fat.readUInt32LE(cluster * 4) & 0x0fffffff
        : 0x0fffffff;
    }
    if (this.bits === 16) {
      return cluster * 2 + 2 <= fat.length ? fat.readUInt16LE(cluster * 2) : 0xffff;
    }
    const at = Math.floor(cluster * 1.5);
    if (at + 2 > fat.length) return 0xfff;
    const v = fat.readUInt16LE(at);
    return cluster & 1 ? v >> 4 : v & 0x0fff;
  }

  private chain(first: number): number[] {
    const end = this.bits === 32 ? 0x0ffffff8 : this.bits === 16 ? 0xfff8 : 0xff8;
    const out: number[] = [];
    let c = first;
    while (c >= 2 && c < end) {
      if (c - 2 >= this.clusters || out.length > this.clusters) {
        throw damaged("a FAT cluster chain leaves the volume or loops");
      }
      out.push(c);
      c = this.next(c);
    }
    return out;
  }

  private clusterOffset(cluster: number): number {
    return this.dataOffset + (cluster - 2) * this.clusterSize;
  }

  private async dirBytes(cluster: number | null): Promise<Buffer> {
    if (cluster === null) {
      return this.source.read(this.rootOffset, this.rootEntries * 32);
    }
    const parts: Buffer[] = [];
    for (const c of this.chain(cluster)) {
      parts.push(await this.source.read(this.clusterOffset(c), this.clusterSize));
      if (parts.length * this.clusterSize > 64 * 1024 * 1024) {
        throw new GuestFsError("limit", "a folder too large");
      }
    }
    return Buffer.concat(parts);
  }

  private async entries(cluster: number | null): Promise<FatEntry[]> {
    const data = await this.dirBytes(cluster);
    const out: FatEntry[] = [];
    let longName: string[] = [];
    for (let at = 0; at + 32 <= data.length; at += 32) {
      const first = data.readUInt8(at);
      if (first === 0) break;
      const attr = data.readUInt8(at + 11);
      if (first === 0xe5) {
        longName = [];
        continue;
      }
      if (attr === 0x0f) {
        const order = first & 0x3f;
        const part = Buffer.concat([
          data.subarray(at + 1, at + 11),
          data.subarray(at + 14, at + 26),
          data.subarray(at + 28, at + 32),
        ])
          .toString("utf16le")
          .replace(/\0.*$/s, "");
        if (first & 0x40) longName = [];
        longName[order - 1] = part;
        continue;
      }
      if (attr & 0x08) {
        longName = [];
        continue; // the volume label
      }
      const base = data.toString("latin1", at, at + 8).trimEnd();
      const ext = data.toString("latin1", at + 8, at + 11).trimEnd();
      const shortName = ext ? `${base}.${ext}` : base;
      const name = longName.length > 0 ? longName.join("") : shortName;
      longName = [];
      if (name === "." || name === "..") continue;
      const high = this.bits === 32 ? data.readUInt16LE(at + 20) : 0;
      const dir = (attr & 0x10) !== 0;
      out.push({
        name,
        type: dir ? "dir" : "file",
        size: dir ? null : data.readUInt32LE(at + 28),
        mtime: dosTime(data.readUInt16LE(at + 24), data.readUInt16LE(at + 22)),
        cluster: high * 65536 + data.readUInt16LE(at + 26),
      });
      if (out.length > MAX_DIR_ENTRIES)
        throw new GuestFsError("limit", "a folder with too many entries");
    }
    return out;
  }

  private async resolve(path: string): Promise<FatEntry | null> {
    let entry: FatEntry = { name: "/", type: "dir", size: null, mtime: null, cluster: 0 };
    let folder: number | null = this.bits === 32 ? this.rootCluster : null;
    for (const part of pathParts(path)) {
      if (entry.type !== "dir") return null;
      const lower = part.toLowerCase();
      const found = (await this.entries(folder)).find((e) => e.name.toLowerCase() === lower);
      if (!found) return null;
      entry = found;
      folder = found.cluster === 0 && this.bits !== 32 ? null : found.cluster;
    }
    return entry;
  }

  async list(path: string): Promise<FsEntry[]> {
    const dir = await this.resolve(path);
    if (!dir) throw new GuestFsError("not_found", "no such folder");
    if (dir.type !== "dir") throw new GuestFsError("not_a_directory", "not a folder");
    const isRoot = pathParts(path).length === 0;
    const cluster = isRoot
      ? this.bits === 32
        ? this.rootCluster
        : null
      : dir.cluster || (this.bits === 32 ? this.rootCluster : null);
    return (await this.entries(cluster)).map(({ cluster: _c, ...entry }) => entry);
  }

  async stat(path: string): Promise<FsEntry | null> {
    const entry = await this.resolve(path);
    if (!entry) return null;
    const { cluster: _c, ...rest } = entry;
    return rest;
  }

  async open(path: string): Promise<FsFile> {
    const entry = await this.resolve(path);
    if (!entry) throw new GuestFsError("not_found", "no such file");
    if (entry.type !== "file") throw new GuestFsError("not_a_file", "not a regular file");
    const size = entry.size ?? 0;
    const clusters = size > 0 ? this.chain(entry.cluster) : [];
    if (clusters.length * this.clusterSize < size) {
      throw damaged("a FAT file shorter than its size");
    }
    return {
      size,
      read: async (offset, length) => {
        const end = Math.min(size, offset + length);
        if (end <= offset) return Buffer.alloc(0);
        const out = Buffer.alloc(end - offset);
        for (let at = offset; at < end; ) {
          const index = Math.floor(at / this.clusterSize);
          const inCluster = at % this.clusterSize;
          const take = Math.min(this.clusterSize - inCluster, end - at);
          (
            await this.source.read(this.clusterOffset(clusters[index] as number) + inCluster, take)
          ).copy(out, at - offset);
          at += take;
        }
        return out;
      },
    };
  }
}
