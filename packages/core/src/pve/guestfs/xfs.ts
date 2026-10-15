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
 * A read-only XFS reader in user space (version 4 and 5 file systems): the superblock, inodes
 * (v2 and v3, big timestamps, 64-bit extent counters), the data fork in extent and B+tree
 * form, and folders in every form (short form in the inode, block, leaf and node folders, whose
 * data blocks hold every entry). The XFS log is not replayed: a restore point of a running VM
 * shows what XFS had written to its places (the guest agent's freeze makes that consistent).
 */

const FORMAT_LOCAL = 1;
const FORMAT_EXTENTS = 2;
const FORMAT_BTREE = 3;
const INCOMPAT_FTYPE = 0x1;
const INCOMPAT_KNOWN = 0x1 | 0x2 | 0x4 | 0x8 | 0x20;
const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;
const MAX_EXTENTS = 1_000_000;
const MAX_BTREE_DEPTH = 8;
/** Folder data lives below 32 GiB of the folder's address space; leaf and free blocks above. */
const DIR_LEAF_OFFSET = 32 * 1024 ** 3;

interface Extent {
  logical: number;
  physical: number; // file system block number (AG encoded)
  length: number;
  unwritten: boolean;
}

interface Inode {
  number: number;
  mode: number;
  size: number;
  mtime: string | null;
  format: number;
  fork: Buffer;
  extents: number;
}

export async function isXfs(source: ByteSource): Promise<boolean> {
  if (source.size < 4096) return false;
  return (await source.read(0, 4)).toString("latin1") === "XFSB";
}

export class XfsFileSystem implements GuestFileSystem {
  readonly type = "xfs" as const;
  label: string | null = null;
  readonly note = null;
  private blockSize = 4096;
  private agBlocks = 0;
  private agBlkLog = 0;
  private inopbLog = 0;
  private inodeSize = 512;
  private rootIno = 0;
  private dirBlockSize = 4096;
  private v5 = false;
  private ftype = false;
  private cache = new Map<number, Inode>();

  private constructor(private readonly source: ByteSource) {}

  static async open(source: ByteSource): Promise<XfsFileSystem> {
    const fs = new XfsFileSystem(source);
    await fs.init();
    return fs;
  }

  private async init(): Promise<void> {
    const sb = await this.source.read(0, 512);
    if (sb.toString("latin1", 0, 4) !== "XFSB") throw damaged("no XFS superblock");
    this.blockSize = sb.readUInt32BE(4);
    this.rootIno = Number(sb.readBigUInt64BE(56));
    this.agBlocks = sb.readUInt32BE(84);
    const version = sb.readUInt16BE(100) & 0xf;
    this.inodeSize = sb.readUInt16BE(104);
    this.inopbLog = sb.readUInt8(123);
    this.agBlkLog = sb.readUInt8(124);
    const dirBlkLog = sb.readUInt8(192);
    this.v5 = version === 5;
    const incompat = this.v5 ? sb.readUInt32BE(216) : 0;
    if (incompat & ~INCOMPAT_KNOWN) {
      throw new GuestFsError(
        "unsupported",
        `XFS features this reader does not know (0x${incompat.toString(16)})`,
      );
    }
    // Version 4: the folder entry type is a features2 bit.
    this.ftype = this.v5 ? (incompat & INCOMPAT_FTYPE) !== 0 : (sb.readUInt32BE(200) & 0x200) !== 0;
    if (
      this.blockSize < 512 ||
      this.blockSize > 65536 ||
      this.inodeSize < 256 ||
      this.inodeSize > 2048 ||
      this.agBlocks === 0 ||
      this.agBlkLog > 31 ||
      dirBlkLog > 8 ||
      !Number.isSafeInteger(this.rootIno)
    ) {
      throw damaged("an impossible XFS geometry");
    }
    this.dirBlockSize = this.blockSize << dirBlkLog;
    const label = sb.toString("utf8", 108, 120).replace(/\0.*$/s, "");
    this.label = label || null;
  }

  /** The byte offset of an AG-encoded file system block. */
  private blockOffset(fsb: number): number {
    const ag = Math.floor(fsb / 2 ** this.agBlkLog);
    const agb = fsb % 2 ** this.agBlkLog;
    if (agb >= this.agBlocks) throw damaged("an XFS block outside its allocation group");
    return (ag * this.agBlocks + agb) * this.blockSize;
  }

  private readFsBlock(fsb: number): Promise<Buffer> {
    return this.source.read(this.blockOffset(fsb), this.blockSize);
  }

  private async inode(number: number): Promise<Inode> {
    const cached = this.cache.get(number);
    if (cached) return cached;
    const perBlock = 2 ** this.inopbLog;
    const blockInAgBits = 2 ** (this.agBlkLog + this.inopbLog);
    const ag = Math.floor(number / blockInAgBits);
    const agb = Math.floor(number / perBlock) % 2 ** this.agBlkLog;
    const index = number % perBlock;
    if (agb >= this.agBlocks) throw damaged(`XFS inode ${number} lies outside its group`);
    const offset = (ag * this.agBlocks + agb) * this.blockSize + index * this.inodeSize;
    const raw = await this.source.read(offset, this.inodeSize);
    if (raw.toString("latin1", 0, 2) !== "IN") throw damaged(`XFS inode ${number} is damaged`);
    const version = raw.readUInt8(4);
    const forkStart = version >= 3 ? 176 : 100;
    const forkOff = raw.readUInt8(82);
    const forkEnd = forkOff ? forkStart + forkOff * 8 : this.inodeSize;
    if (forkEnd > this.inodeSize || forkEnd < forkStart)
      throw damaged(`XFS inode ${number}: an impossible fork`);
    const flags2 = version >= 3 ? raw.readBigUInt64BE(120) : 0n;
    const bigtime = (flags2 & 0x8n) !== 0n;
    const nrext64 = (flags2 & 0x10n) !== 0n;
    let seconds: number;
    if (bigtime) {
      seconds = Number(raw.readBigUInt64BE(40) / 1_000_000_000n) - 2 ** 31;
    } else {
      seconds = raw.readInt32BE(40);
    }
    const size = Number(raw.readBigUInt64BE(56));
    if (!Number.isSafeInteger(size) || size < 0)
      throw damaged(`XFS inode ${number}: an impossible size`);
    const extents = nrext64 ? Number(raw.readBigUInt64BE(24)) : raw.readUInt32BE(76);
    const inode: Inode = {
      number,
      mode: raw.readUInt16BE(2),
      size,
      mtime: seconds > 0 && seconds < 32503680000 ? new Date(seconds * 1000).toISOString() : null,
      format: raw.readUInt8(5),
      fork: Buffer.from(raw.subarray(forkStart, forkEnd)),
      extents,
    };
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(number, inode);
    return inode;
  }

  private parseExtents(buf: Buffer, at: number, count: number, out: Extent[]): void {
    for (let i = 0; i < count; i++) {
      const p = at + i * 16;
      if (p + 16 > buf.length) throw damaged("XFS extents beyond their block");
      const hi = buf.readBigUInt64BE(p);
      const lo = buf.readBigUInt64BE(p + 8);
      const unwritten = hi >> 63n === 1n;
      const logical = Number((hi >> 9n) & ((1n << 54n) - 1n));
      const physical = Number(((hi & 0x1ffn) << 43n) | (lo >> 21n));
      const length = Number(lo & 0x1fffffn);
      out.push({ logical, physical, length, unwritten });
      if (out.length > MAX_EXTENTS) throw new GuestFsError("limit", "a file with too many extents");
    }
  }

  private async extentsOf(inode: Inode): Promise<Extent[]> {
    const out: Extent[] = [];
    if (inode.format === FORMAT_EXTENTS) {
      if (inode.extents * 16 > inode.fork.length)
        throw damaged(`XFS inode ${inode.number}: too many extents`);
      this.parseExtents(inode.fork, 0, inode.extents, out);
    } else if (inode.format === FORMAT_BTREE) {
      const level = inode.fork.readUInt16BE(0);
      const records = inode.fork.readUInt16BE(2);
      const maxRecs = Math.floor((inode.fork.length - 4) / 16);
      if (level === 0 || level > MAX_BTREE_DEPTH || records > maxRecs)
        throw damaged("a damaged XFS block map");
      const header = this.v5 ? 72 : 24;
      const walk = async (fsb: number, depth: number): Promise<void> => {
        if (depth > MAX_BTREE_DEPTH) throw damaged("an XFS block map too deep");
        const block = await this.readFsBlock(fsb);
        const magic = block.toString("latin1", 0, 4);
        if (magic !== "BMAP" && magic !== "BMA3") throw damaged("a damaged XFS block map node");
        const lvl = block.readUInt16BE(4);
        const n = block.readUInt16BE(6);
        if (lvl === 0) {
          this.parseExtents(block, header, n, out);
          return;
        }
        const max = Math.floor((this.blockSize - header) / 16);
        if (n > max) throw damaged("a damaged XFS block map node");
        for (let i = 0; i < n; i++) {
          await walk(Number(block.readBigUInt64BE(header + max * 8 + i * 8)), depth + 1);
        }
      };
      for (let i = 0; i < records; i++) {
        await walk(Number(inode.fork.readBigUInt64BE(4 + maxRecs * 8 + i * 8)), 1);
      }
    } else {
      throw new GuestFsError("unsupported", `XFS data fork format ${inode.format}`);
    }
    out.sort((a, b) => a.logical - b.logical);
    return out;
  }

  private async reader(inode: Inode): Promise<FsFile> {
    if (inode.format === FORMAT_LOCAL) {
      const data = inode.fork.subarray(0, Math.min(inode.size, inode.fork.length));
      return { size: inode.size, read: async (o, l) => Buffer.from(data.subarray(o, o + l)) };
    }
    const extents = await this.extentsOf(inode);
    const bs = this.blockSize;
    const find = (logical: number) => {
      let lo = 0;
      let hi = extents.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const e = extents[mid] as Extent;
        if (logical < e.logical) hi = mid - 1;
        else if (logical >= e.logical + e.length) lo = mid + 1;
        else return e;
      }
      return null;
    };
    return {
      size: inode.size,
      read: async (offset, length) => {
        const end = Math.min(inode.size, offset + length);
        if (end <= offset) return Buffer.alloc(0);
        const out = Buffer.alloc(end - offset);
        for (let at = offset; at < end; ) {
          const logical = Math.floor(at / bs);
          const inBlock = at % bs;
          const e = find(logical);
          let take = Math.min(bs - inBlock, end - at);
          if (e && !e.unwritten) {
            // Contiguous blocks of one extent in one read.
            const blocksLeft = e.logical + e.length - logical;
            take = Math.min(blocksLeft * bs - inBlock, end - at, 4 * 1024 * 1024);
            const physical = e.physical + (logical - e.logical);
            const sameAg =
              Math.floor(physical / 2 ** this.agBlkLog) ===
              Math.floor((physical + Math.ceil((inBlock + take) / bs) - 1) / 2 ** this.agBlkLog);
            if (!sameAg) take = Math.min(bs - inBlock, end - at);
            (await this.source.read(this.blockOffset(physical) + inBlock, take)).copy(
              out,
              at - offset,
            );
          }
          at += take;
        }
        return out;
      },
    };
  }

  private async entries(dir: Inode): Promise<{ name: string; inode: number }[]> {
    if ((dir.mode & S_IFMT) !== S_IFDIR) throw new GuestFsError("not_a_directory", "not a folder");
    const out: { name: string; inode: number }[] = [];
    if (dir.format === FORMAT_LOCAL) {
      const f = dir.fork;
      const count = f.readUInt8(0);
      const wide = f.readUInt8(1) > 0;
      const inoBytes = wide ? 8 : 4;
      let at = 2 + inoBytes;
      for (let i = 0; i < Math.max(count, f.readUInt8(1)); i++) {
        if (at + 3 > f.length) break;
        const nameLen = f.readUInt8(at);
        const nameAt = at + 3;
        const inoAt = nameAt + nameLen + (this.ftype ? 1 : 0);
        if (nameLen === 0 || inoAt + inoBytes > f.length) break;
        const ino = wide ? Number(f.readBigUInt64BE(inoAt)) : f.readUInt32BE(inoAt);
        out.push({ name: f.toString("utf8", nameAt, nameAt + nameLen), inode: ino });
        at = inoAt + inoBytes;
      }
      return out;
    }
    const file = await this.reader(dir);
    const dataEnd = Math.min(dir.size, DIR_LEAF_OFFSET);
    const header = this.v5 ? 64 : 16;
    for (let blockAt = 0; blockAt < dataEnd; blockAt += this.dirBlockSize) {
      const block = await file.read(blockAt, this.dirBlockSize);
      const magic = block.toString("latin1", 0, 4);
      let end = block.length;
      if (magic === "XD2B" || magic === "XDB3") {
        const count = block.readUInt32BE(block.length - 8);
        end = block.length - 8 - count * 8;
      } else if (magic !== "XD2D" && magic !== "XDD3") {
        continue; // a hole, or not a data block
      }
      for (let at = header; at + 8 <= end; ) {
        if (block.readUInt16BE(at) === 0xffff) {
          const length = block.readUInt16BE(at + 2);
          if (length < 8 || length % 8 !== 0) break;
          at += length;
          continue;
        }
        const ino = Number(block.readBigUInt64BE(at));
        const nameLen = block.readUInt8(at + 8);
        const size = Math.ceil((8 + 1 + nameLen + (this.ftype ? 1 : 0) + 2) / 8) * 8;
        if (nameLen === 0 || at + size > end) break;
        const name = block.toString("utf8", at + 9, at + 9 + nameLen);
        if (name !== "." && name !== "..") {
          out.push({ name, inode: ino });
          if (out.length > MAX_DIR_ENTRIES)
            throw new GuestFsError("limit", "a folder with too many entries");
        }
        at += size;
      }
    }
    return out;
  }

  private async resolve(path: string): Promise<Inode | null> {
    let current = await this.inode(this.rootIno);
    for (const part of pathParts(path)) {
      if ((current.mode & S_IFMT) !== S_IFDIR) return null;
      const found = (await this.entries(current)).find((e) => e.name === part);
      if (!found) return null;
      current = await this.inode(found.inode);
    }
    return current;
  }

  private entryOf(name: string, inode: Inode): FsEntry {
    const kind = inode.mode & S_IFMT;
    const type =
      kind === S_IFDIR ? "dir" : kind === S_IFREG ? "file" : kind === S_IFLNK ? "symlink" : "other";
    return { name, type, size: type === "file" ? inode.size : null, mtime: inode.mtime };
  }

  async list(path: string): Promise<FsEntry[]> {
    const dir = await this.resolve(path);
    if (!dir) throw new GuestFsError("not_found", "no such folder");
    const out: FsEntry[] = [];
    for (const entry of await this.entries(dir)) {
      try {
        out.push(this.entryOf(entry.name, await this.inode(entry.inode)));
      } catch {
        out.push({ name: entry.name, type: "other", size: null, mtime: null });
      }
    }
    return out;
  }

  async stat(path: string): Promise<FsEntry | null> {
    const inode = await this.resolve(path);
    return inode ? this.entryOf(pathParts(path).at(-1) ?? "/", inode) : null;
  }

  async open(path: string): Promise<FsFile> {
    const inode = await this.resolve(path);
    if (!inode) throw new GuestFsError("not_found", "no such file");
    if ((inode.mode & S_IFMT) !== S_IFREG)
      throw new GuestFsError("not_a_file", "not a regular file");
    return this.reader(inode);
  }
}
