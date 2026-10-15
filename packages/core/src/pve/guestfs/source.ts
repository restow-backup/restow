/**
 * The byte sources the guest file system readers work on (docs/PVE.md, "Files of a VM").
 *
 * Every reader in this folder parses data that comes from a guest: a VM's disk as the backup
 * read it. That data is hostile by assumption (a compromised guest can write any byte), so the
 * readers never trust a length, an offset or a count from it: every read goes through a
 * {@link ByteSource} that refuses to leave its bounds, sizes are checked against limits before
 * memory is allocated, and loops in on-disk structures end at fixed limits. Nothing here mounts
 * anything or hands guest data to the kernel; this folder imports nothing outside itself and
 * runs in a sandboxed child process (sandbox-child.ts).
 */

/** A failure caused by the guest data (damaged, unsupported or hostile), not by Restow. */
export class GuestFsError extends Error {
  constructor(
    readonly code:
      | "damaged"
      | "unsupported"
      | "not_found"
      | "not_a_directory"
      | "not_a_file"
      | "limit"
      | "io",
    message: string,
  ) {
    super(message);
    this.name = "GuestFsError";
  }
}

export function damaged(message: string): GuestFsError {
  return new GuestFsError("damaged", message);
}

/** Random access to bytes: a disk, a partition, a logical volume. */
export interface ByteSource {
  readonly size: number;
  /** Exactly `length` bytes at `offset`; throws when that leaves the source. */
  read(offset: number, length: number): Promise<Buffer>;
}

/** The most one read may ask for (a file is read in pieces). */
export const MAX_READ_BYTES = 16 * 1024 * 1024;

export function checkRange(size: number, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > MAX_READ_BYTES ||
    offset + length > size
  ) {
    throw damaged(`a read of ${length} bytes at ${offset} leaves a source of ${size} bytes`);
  }
}

/** A window of another source (a partition, a segment of a logical volume). */
export class SliceSource implements ByteSource {
  readonly size: number;
  constructor(
    private readonly base: ByteSource,
    private readonly offset: number,
    size: number,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > base.size
    ) {
      throw damaged(`a slice of ${size} bytes at ${offset} leaves a source of ${base.size} bytes`);
    }
    this.size = size;
  }

  read(offset: number, length: number): Promise<Buffer> {
    checkRange(this.size, offset, length);
    return this.base.read(this.offset + offset, length);
  }
}

/** Pieces of other sources one after another (a logical volume of several segments). */
export class ConcatSource implements ByteSource {
  readonly size: number;
  private readonly starts: number[] = [];

  constructor(private readonly parts: readonly ByteSource[]) {
    let at = 0;
    for (const part of parts) {
      this.starts.push(at);
      at += part.size;
    }
    if (!Number.isSafeInteger(at)) {
      throw damaged("a volume larger than this reader handles");
    }
    this.size = at;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    checkRange(this.size, offset, length);
    const out = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const at = offset + done;
      let i = this.starts.length - 1;
      while (i > 0 && (this.starts[i] as number) > at) i--;
      const part = this.parts[i] as ByteSource;
      const inPart = at - (this.starts[i] as number);
      const take = Math.min(length - done, part.size - inPart);
      if (take <= 0) {
        throw damaged("a read past the end of a volume");
      }
      (await part.read(inPart, take)).copy(out, done);
      done += take;
    }
    return out;
  }
}

/** A source in memory (tests, and the small structures read whole). */
export class BufferSource implements ByteSource {
  constructor(private readonly data: Buffer) {}
  get size(): number {
    return this.data.length;
  }
  async read(offset: number, length: number): Promise<Buffer> {
    checkRange(this.size, offset, length);
    return Buffer.from(this.data.subarray(offset, offset + length));
  }
}

/** A 64-bit little-endian value as a number, refused beyond 2^53. */
export function u64(buf: Buffer, at: number): number {
  const value = buf.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw damaged("a 64-bit value larger than this reader handles");
  }
  return Number(value);
}

/** One entry of a folder as every reader reports it. */
export interface FsEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
  /** ISO time of the last change of the content, when the file system records it. */
  mtime: string | null;
}

/** A file opened for reading. */
export interface FsFile {
  readonly size: number;
  /** Bytes [offset, offset + length) of the file (holes read as zeros). */
  read(offset: number, length: number): Promise<Buffer>;
}

/** What every file system reader offers: read only, never following symbolic links. */
export interface GuestFileSystem {
  readonly type: "ext4" | "ntfs" | "vfat" | "xfs";
  readonly label: string | null;
  /** A remark about how the file system was read (a journal replayed, or not). */
  readonly note: string | null;
  /** Every entry of a folder (no "." and ".."), in the order the file system keeps them. */
  list(path: string): Promise<FsEntry[]>;
  /** The entry at `path` ("/" is the root folder), or null. */
  stat(path: string): Promise<FsEntry | null>;
  /** A regular file at `path`. */
  open(path: string): Promise<FsFile>;
}

/** At most this many entries per folder are read (a hostile folder cannot exhaust memory). */
export const MAX_DIR_ENTRIES = 200_000;
/** Paths deeper than this are refused. */
export const MAX_PATH_DEPTH = 256;

/** The parts of an absolute path inside a file system ("/a/b" -> ["a", "b"]). */
export function pathParts(path: string): string[] {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new GuestFsError("not_found", "a path with .. is not looked up");
  }
  if (parts.length > MAX_PATH_DEPTH) {
    throw new GuestFsError("limit", "the path is too deep");
  }
  return parts;
}

/** A UNIX time in seconds as ISO, or null when it is not a usable time. */
export function isoSeconds(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 32503680000) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}
