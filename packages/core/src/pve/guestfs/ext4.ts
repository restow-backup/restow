import {
  type ByteSource,
  damaged,
  type FsEntry,
  type FsFile,
  type GuestFileSystem,
  GuestFsError,
  isoSeconds,
  MAX_DIR_ENTRIES,
  pathParts,
} from "./source.js";

/**
 * A read-only reader of ext2, ext3 and ext4 in user space: superblock, group descriptors
 * (32 and 64 bit), inodes, extent trees and the classic block maps, linear and hashed folders
 * (a hashed folder's leaf blocks are ordinary entry blocks), small inline files and folders, and
 * the jbd2 journal: a restore point of a running VM usually holds committed transactions that
 * were not written to their places yet; they are applied in memory before anything is read
 * (nothing is ever written). Encrypted folders and files are not readable.
 */

const SUPERBLOCK_OFFSET = 1024;
const EXT_MAGIC = 0xef53;
const ROOT_INODE = 2;
const JOURNAL_MAGIC = 0xc03b3998;

const INCOMPAT_FILETYPE = 0x2;
const INCOMPAT_RECOVER = 0x4;
const INCOMPAT_JOURNAL_DEV = 0x8;
const INCOMPAT_META_BG = 0x10;
const INCOMPAT_EXTENTS = 0x40;
const INCOMPAT_64BIT = 0x80;
const INCOMPAT_INLINE_DATA = 0x8000;
/** Features this reader understands; another incompatible one means it must not guess. */
const INCOMPAT_KNOWN =
  INCOMPAT_FILETYPE |
  INCOMPAT_RECOVER |
  INCOMPAT_META_BG |
  INCOMPAT_EXTENTS |
  INCOMPAT_64BIT |
  0x200 /* FLEX_BG */ |
  0x400 /* EA_INODE */ |
  0x1000 /* DIRDATA: never set by mkfs */ |
  0x2000 /* CSUM_SEED */ |
  0x4000 /* LARGEDIR */ |
  INCOMPAT_INLINE_DATA |
  0x10000 /* ENCRYPT: per file */ |
  0x20000; /* CASEFOLD: names stay readable */

const FLAG_EXTENTS = 0x80000;
const FLAG_INLINE = 0x10000000;
const FLAG_ENCRYPT = 0x800;

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;

const MAX_EXTENT_DEPTH = 5;
const MAX_EXTENTS = 1_000_000;
const MAX_GROUPS = 4_000_000;

interface Inode {
  number: number;
  mode: number;
  size: number;
  mtime: string | null;
  flags: number;
  block: Buffer; // i_block, 60 bytes
}

interface Extent {
  logical: number;
  physical: number;
  length: number;
  uninit: boolean;
}

/** Whether `source` holds an ext2/3/4 file system. */
export async function isExt(source: ByteSource): Promise<boolean> {
  if (source.size < SUPERBLOCK_OFFSET + 1024) {
    return false;
  }
  const sb = await source.read(SUPERBLOCK_OFFSET, 1024);
  return sb.readUInt16LE(56) === EXT_MAGIC;
}

export class Ext4FileSystem implements GuestFileSystem {
  readonly type = "ext4" as const;
  label: string | null = null;
  note: string | null = null;
  private blockSize = 1024;
  private inodesPerGroup = 0;
  private inodeSize = 128;
  private groupCount = 0;
  private descSize = 32;
  private firstDataBlock = 0;
  private incompat = 0;
  private descriptors: Buffer | null = null;
  private overlay = new Map<number, number>();
  private inodeCache = new Map<number, Inode>();

  private constructor(private readonly source: ByteSource) {}

  static async open(source: ByteSource): Promise<Ext4FileSystem> {
    const fs = new Ext4FileSystem(source);
    await fs.init();
    return fs;
  }

  private async init(): Promise<void> {
    const sb = await this.source.read(SUPERBLOCK_OFFSET, 1024);
    if (sb.readUInt16LE(56) !== EXT_MAGIC) {
      throw damaged("no ext superblock");
    }
    const logBlock = sb.readUInt32LE(24);
    if (logBlock > 6) {
      throw damaged("an impossible ext block size");
    }
    this.blockSize = 1024 << logBlock;
    this.incompat = sb.readUInt32LE(96);
    if (this.incompat & INCOMPAT_JOURNAL_DEV) {
      throw new GuestFsError("unsupported", "an external journal device, not a file system");
    }
    const unknown = this.incompat & ~INCOMPAT_KNOWN;
    if (unknown) {
      throw new GuestFsError(
        "unsupported",
        `ext features this reader does not know (0x${unknown.toString(16)})`,
      );
    }
    const blocksLo = sb.readUInt32LE(4);
    const blocksHi = this.incompat & INCOMPAT_64BIT ? sb.readUInt32LE(336) : 0;
    const blocks = blocksHi * 2 ** 32 + blocksLo;
    const blocksPerGroup = sb.readUInt32LE(32);
    this.inodesPerGroup = sb.readUInt32LE(40);
    this.firstDataBlock = sb.readUInt32LE(20);
    const rev = sb.readUInt32LE(76);
    this.inodeSize = rev >= 1 ? sb.readUInt16LE(88) : 128;
    if (
      blocksPerGroup === 0 ||
      this.inodesPerGroup === 0 ||
      this.inodeSize < 128 ||
      this.inodeSize > this.blockSize ||
      (this.inodeSize & (this.inodeSize - 1)) !== 0
    ) {
      throw damaged("an impossible ext geometry");
    }
    this.groupCount = Math.ceil((blocks - this.firstDataBlock) / blocksPerGroup);
    if (this.groupCount <= 0 || this.groupCount > MAX_GROUPS) {
      throw damaged("an impossible number of ext block groups");
    }
    this.descSize = this.incompat & INCOMPAT_64BIT ? sb.readUInt16LE(254) || 64 : 32;
    if (this.descSize < 32 || this.descSize > 1024) {
      throw damaged("an impossible ext group descriptor size");
    }
    if (this.incompat & INCOMPAT_META_BG) {
      throw new GuestFsError("unsupported", "ext meta block groups are not supported");
    }
    const label = sb.toString("utf8", 120, 136).replace(/\0.*$/s, "");
    this.label = label || null;
    const descBytes = this.groupCount * this.descSize;
    if (descBytes > 256 * 1024 * 1024) {
      throw damaged("ext group descriptors too large");
    }
    const descStart = (this.firstDataBlock + 1) * this.blockSize;
    const parts: Buffer[] = [];
    for (let at = 0; at < descBytes; at += 8 * 1024 * 1024) {
      parts.push(await this.source.read(descStart + at, Math.min(8 * 1024 * 1024, descBytes - at)));
    }
    this.descriptors = Buffer.concat(parts);
    const journalInode = sb.readUInt32LE(224);
    const compat = sb.readUInt32LE(92);
    if (compat & 0x4 && journalInode > 0) {
      try {
        const applied = await this.replayJournal(journalInode);
        if (this.incompat & INCOMPAT_RECOVER) {
          this.note = applied > 0 ? "journal_replayed" : null;
        }
      } catch {
        this.overlay.clear();
        this.note = this.incompat & INCOMPAT_RECOVER ? "journal_not_replayed" : null;
      }
      this.inodeCache.clear();
    }
  }

  /** One file system block, from the journal when a committed transaction replaced it. */
  private readBlock(block: number): Promise<Buffer> {
    const fromJournal = this.overlay.get(block);
    if (!Number.isSafeInteger(block) || block < 0) {
      throw damaged("an impossible block number");
    }
    return this.source.read((fromJournal ?? block) * this.blockSize, this.blockSize);
  }

  private async inode(number: number): Promise<Inode> {
    const cached = this.inodeCache.get(number);
    if (cached) {
      return cached;
    }
    if (number < 1 || number > this.groupCount * this.inodesPerGroup) {
      throw damaged(`inode ${number} does not exist`);
    }
    const group = Math.floor((number - 1) / this.inodesPerGroup);
    const index = (number - 1) % this.inodesPerGroup;
    const desc = this.descriptors as Buffer;
    const at = group * this.descSize;
    const tableLo = desc.readUInt32LE(at + 8);
    const tableHi = this.descSize >= 64 ? desc.readUInt32LE(at + 40) : 0;
    const table = tableHi * 2 ** 32 + tableLo;
    const byteInTable = index * this.inodeSize;
    const block = table + Math.floor(byteInTable / this.blockSize);
    const data = await this.readBlock(block);
    const offset = byteInTable % this.blockSize;
    const raw = data.subarray(offset, offset + this.inodeSize);
    const mode = raw.readUInt16LE(0);
    const sizeLo = raw.readUInt32LE(4);
    const sizeHi = raw.readUInt32LE(108);
    const size = sizeHi * 2 ** 32 + sizeLo;
    if (!Number.isSafeInteger(size)) {
      throw damaged(`inode ${number} has an impossible size`);
    }
    let seconds = raw.readInt32LE(16);
    if (this.inodeSize > 128 && raw.readUInt16LE(128) >= 24) {
      // i_mtime_extra: the two low bits extend the seconds beyond 2038.
      seconds += (raw.readUInt32LE(0x88) & 3) * 2 ** 32;
    }
    const inode: Inode = {
      number,
      mode,
      size,
      mtime: isoSeconds(seconds),
      flags: raw.readUInt32LE(32),
      block: Buffer.from(raw.subarray(40, 100)),
    };
    if (this.inodeCache.size > 10_000) {
      this.inodeCache.clear();
    }
    this.inodeCache.set(number, inode);
    return inode;
  }

  // --- block mapping ----------------------------------------------------------------------------

  private async extents(inode: Inode): Promise<Extent[]> {
    const out: Extent[] = [];
    const walk = async (node: Buffer, depth: number): Promise<void> => {
      if (node.readUInt16LE(0) !== 0xf30a) {
        throw damaged(`inode ${inode.number}: an extent node without its magic`);
      }
      const entries = node.readUInt16LE(2);
      const level = node.readUInt16LE(6);
      if (level !== depth || depth < 0 || 12 + entries * 12 > node.length) {
        throw damaged(`inode ${inode.number}: a damaged extent tree`);
      }
      for (let i = 0; i < entries; i++) {
        const at = 12 + i * 12;
        if (level === 0) {
          let length = node.readUInt16LE(at + 4);
          const uninit = length > 32768;
          if (uninit) length -= 32768;
          out.push({
            logical: node.readUInt32LE(at),
            physical: node.readUInt16LE(at + 6) * 2 ** 32 + node.readUInt32LE(at + 8),
            length,
            uninit,
          });
          if (out.length > MAX_EXTENTS) {
            throw new GuestFsError("limit", "a file with too many extents");
          }
        } else {
          const child = node.readUInt32LE(at + 4) + node.readUInt16LE(at + 8) * 2 ** 32;
          await walk(await this.readBlock(child), depth - 1);
        }
      }
    };
    const depth = inode.block.readUInt16LE(6);
    if (depth > MAX_EXTENT_DEPTH) {
      throw damaged(`inode ${inode.number}: an extent tree too deep`);
    }
    await walk(inode.block, depth);
    out.sort((a, b) => a.logical - b.logical);
    return out;
  }

  /** A mapper from logical to physical blocks for one inode (0: a hole). */
  private async mapper(inode: Inode): Promise<(logical: number) => Promise<number>> {
    if (inode.flags & FLAG_EXTENTS) {
      const extents = await this.extents(inode);
      return async (logical) => {
        let lo = 0;
        let hi = extents.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const e = extents[mid] as Extent;
          if (logical < e.logical) hi = mid - 1;
          else if (logical >= e.logical + e.length) lo = mid + 1;
          else return e.uninit ? 0 : e.physical + (logical - e.logical);
        }
        return 0;
      };
    }
    const per = this.blockSize / 4;
    const indirect = new Map<number, Buffer>();
    const pointer = async (block: number, index: number): Promise<number> => {
      if (block === 0) return 0;
      let data = indirect.get(block);
      if (!data) {
        data = await this.readBlock(block);
        if (indirect.size > 64) indirect.clear();
        indirect.set(block, data);
      }
      return data.readUInt32LE(index * 4);
    };
    const direct = (i: number) => inode.block.readUInt32LE(i * 4);
    return async (logical) => {
      if (logical < 12) return direct(logical);
      let n = logical - 12;
      if (n < per) return pointer(direct(12), n);
      n -= per;
      if (n < per * per) return pointer(await pointer(direct(13), Math.floor(n / per)), n % per);
      n -= per * per;
      if (n < per * per * per) {
        const first = await pointer(direct(14), Math.floor(n / (per * per)));
        const second = await pointer(first, Math.floor(n / per) % per);
        return pointer(second, n % per);
      }
      throw damaged(`inode ${inode.number}: a block beyond the triple indirect map`);
    };
  }

  /** The content of an inode as a reader (regular files and folders). */
  private async contents(inode: Inode): Promise<FsFile> {
    if (inode.flags & FLAG_ENCRYPT) {
      throw new GuestFsError("unsupported", "the file is encrypted");
    }
    if (inode.flags & FLAG_INLINE) {
      if (inode.size > inode.block.length) {
        throw new GuestFsError("unsupported", "inline data beyond the inode is not supported");
      }
      const data = inode.block.subarray(0, inode.size);
      return {
        size: inode.size,
        read: async (offset, length) => Buffer.from(data.subarray(offset, offset + length)),
      };
    }
    const map = await this.mapper(inode);
    const bs = this.blockSize;
    return {
      size: inode.size,
      read: async (offset, length) => {
        const end = Math.min(inode.size, offset + length);
        if (offset < 0 || end <= offset) return Buffer.alloc(0);
        const out = Buffer.alloc(end - offset);
        for (let at = offset; at < end; ) {
          const logical = Math.floor(at / bs);
          const inBlock = at % bs;
          const take = Math.min(bs - inBlock, end - at);
          const physical = await map(logical);
          if (physical !== 0) {
            (await this.readBlock(physical)).copy(out, at - offset, inBlock, inBlock + take);
          }
          at += take;
        }
        return out;
      },
    };
  }

  // --- folders ----------------------------------------------------------------------------------

  private async entries(dir: Inode): Promise<{ name: string; inode: number; type: number }[]> {
    if ((dir.mode & S_IFMT) !== S_IFDIR) {
      throw new GuestFsError("not_a_directory", "not a folder");
    }
    if (dir.flags & FLAG_ENCRYPT) {
      throw new GuestFsError("unsupported", "the folder is encrypted");
    }
    const out: { name: string; inode: number; type: number }[] = [];
    const parse = (data: Buffer, start: number) => {
      for (let at = start; at + 8 <= data.length; ) {
        const inode = data.readUInt32LE(at);
        const recLen = data.readUInt16LE(at + 4);
        const nameLen = data.readUInt8(at + 6);
        const type = this.incompat & INCOMPAT_FILETYPE ? data.readUInt8(at + 7) : 0;
        if (recLen < 8 || recLen % 4 !== 0 || at + recLen > data.length || 8 + nameLen > recLen) {
          break; // a damaged block: what came before it stays
        }
        if (inode !== 0 && nameLen > 0) {
          const name = data.toString("utf8", at + 8, at + 8 + nameLen);
          if (name !== "." && name !== "..") {
            out.push({ name, inode, type });
            if (out.length > MAX_DIR_ENTRIES) {
              throw new GuestFsError("limit", "a folder with too many entries");
            }
          }
        }
        at += recLen;
      }
    };
    if (dir.flags & FLAG_INLINE) {
      // Four bytes of the parent's inode, then entries.
      parse(dir.block, 4);
      return out;
    }
    const file = await this.contents(dir);
    const blocks = Math.ceil(dir.size / this.blockSize);
    if (blocks > 1_000_000) {
      throw new GuestFsError("limit", "a folder too large");
    }
    for (let i = 0; i < blocks; i++) {
      parse(await file.read(i * this.blockSize, this.blockSize), 0);
    }
    return out;
  }

  private async resolve(path: string): Promise<Inode | null> {
    let current = await this.inode(ROOT_INODE);
    for (const part of pathParts(path)) {
      if ((current.mode & S_IFMT) !== S_IFDIR) {
        return null;
      }
      const found = (await this.entries(current)).find((entry) => entry.name === part);
      if (!found) {
        return null;
      }
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
    if (!dir) {
      throw new GuestFsError("not_found", "no such folder");
    }
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
    if (!inode) return null;
    const parts = pathParts(path);
    return this.entryOf(parts.at(-1) ?? "/", inode);
  }

  async open(path: string): Promise<FsFile> {
    const inode = await this.resolve(path);
    if (!inode) {
      throw new GuestFsError("not_found", "no such file");
    }
    if ((inode.mode & S_IFMT) !== S_IFREG) {
      throw new GuestFsError("not_a_file", "not a regular file");
    }
    return this.contents(inode);
  }

  // --- the journal ------------------------------------------------------------------------------

  /** Apply the committed transactions of the jbd2 journal in memory; returns how many blocks. */
  private async replayJournal(journalInode: number): Promise<number> {
    const inode = await this.inode(journalInode);
    const map = await this.mapper(inode);
    const readJournal = async (logical: number) => {
      const physical = await map(logical);
      if (physical === 0) throw damaged("a hole in the journal");
      return { physical, data: await this.readBlock(physical) };
    };
    const sb = (await readJournal(0)).data;
    if (sb.readUInt32BE(0) !== JOURNAL_MAGIC) {
      throw damaged("no journal superblock");
    }
    const blockType = sb.readUInt32BE(4);
    const maxLen = sb.readUInt32BE(16);
    const first = sb.readUInt32BE(20);
    let sequence = sb.readUInt32BE(24);
    const start = sb.readUInt32BE(28);
    if (start === 0) {
      return 0; // clean
    }
    const incompat = blockType === 4 ? sb.readUInt32BE(40) : 0;
    const is64 = (incompat & 0x2) !== 0;
    const csumV3 = (incompat & 0x10) !== 0;
    const csumV2 = (incompat & 0x8) !== 0;
    let tagBytes: number;
    if (csumV3) {
      tagBytes = is64 ? 16 : 12;
    } else {
      tagBytes = (is64 ? 12 : 8) + (csumV2 ? 2 : 0);
    }
    if (first === 0 || maxLen <= first || start < first || start >= maxLen) {
      throw damaged("an impossible journal geometry");
    }
    const advance = (block: number) => (block + 1 >= maxLen ? first : block + 1);
    // One pass over the committed transactions: remember what each wrote and revoked.
    const writes: { seq: number; target: number; from: number; escaped: boolean }[] = [];
    const revoked = new Map<number, number>();
    let block = start;
    let pending: typeof writes = [];
    for (let guard = 0; guard < maxLen * 2; guard++) {
      const { data } = await readJournal(block);
      if (data.readUInt32BE(0) !== JOURNAL_MAGIC || data.readUInt32BE(8) !== sequence) {
        break;
      }
      const type = data.readUInt32BE(4);
      if (type === 1) {
        // Descriptor: tags, each followed by the block it describes.
        let at = 12;
        let next = advance(block);
        for (let t = 0; t < 10_000 && at + tagBytes <= data.length; t++) {
          const low = data.readUInt32BE(at);
          const flags = csumV3 ? data.readUInt32BE(at + 4) : data.readUInt16BE(at + 6);
          const high = is64 ? data.readUInt32BE(at + (csumV3 ? 8 : 8)) : 0;
          pending.push({
            seq: sequence,
            target: high * 2 ** 32 + low,
            from: next,
            escaped: (flags & 1) !== 0,
          });
          next = advance(next);
          at += tagBytes;
          if (!(flags & 2)) at += 16; // the UUID
          if (flags & 8) break; // the last tag
        }
        block = next;
        continue;
      }
      if (type === 2) {
        writes.push(...pending);
        pending = [];
        sequence = (sequence + 1) >>> 0;
        block = advance(block);
        continue;
      }
      if (type === 5) {
        const count = data.readUInt32BE(12);
        const size = is64 ? 8 : 4;
        for (let at = 16; at + size <= Math.min(count, data.length); at += size) {
          const target = is64 ? Number(data.readBigUInt64BE(at)) : data.readUInt32BE(at);
          revoked.set(target, Math.max(revoked.get(target) ?? 0, sequence));
        }
        block = advance(block);
        continue;
      }
      break;
    }
    // Later transactions win; a block revoked in a transaction at or after a write is not replayed.
    let applied = 0;
    for (const write of writes) {
      const revokedAt = revoked.get(write.target);
      if (revokedAt !== undefined && revokedAt >= write.seq) continue;
      if (write.escaped) continue; // its first bytes looked like the journal magic: rare, skipped
      this.overlay.set(write.target, (await map(write.from)) || 0);
      applied++;
    }
    for (const [target, physical] of this.overlay) {
      if (physical === 0) this.overlay.delete(target);
    }
    return applied;
  }
}
