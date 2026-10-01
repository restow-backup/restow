/**
 * A streaming reader for the tar archives `restic dump` writes (Go's
 * archive/tar: USTAR headers, PAX extended headers for long names and sizes,
 * GNU long-name records are understood as well).
 *
 * The reader hands out one entry at a time with its body as a stream. The
 * caller must finish (or abandon) an entry's body before asking for the next
 * one; leftovers are skipped. Nothing is held in memory but one block.
 */
import { Readable } from "node:stream";

export type TarEntryType = "file" | "directory" | "symlink" | "other";

export interface TarEntry {
  /** Path inside the archive, `/`-separated, without a leading slash. */
  readonly name: string;
  readonly type: TarEntryType;
  readonly size: number;
  readonly mode: number;
  readonly mtime: Date | null;
  readonly linkname: string;
  /** The file's bytes; empty for anything but a regular file. */
  readonly body: Readable;
}

const BLOCK = 512;

class ByteReader {
  private readonly iterator: AsyncIterator<Buffer | Uint8Array>;
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Buffer | Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.ended) {
      return false;
    }
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    return true;
  }

  /** Exactly `size` bytes, or fewer at the end of the stream. */
  async readExact(size: number): Promise<Buffer> {
    while (this.buffer.length < size && (await this.fill())) {
      // keep reading
    }
    const taken = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(taken.length);
    return taken;
  }

  /** Up to `size` bytes, at least one unless the stream is over. */
  async readSome(size: number): Promise<Buffer> {
    if (this.buffer.length === 0) {
      await this.fill();
    }
    const taken = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(taken.length);
    return taken;
  }

  async skip(size: number): Promise<void> {
    let left = size;
    while (left > 0) {
      const taken = await this.readSome(left);
      if (taken.length === 0) {
        throw new Error("tar archive ends inside an entry");
      }
      left -= taken.length;
    }
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) {
      return false;
    }
  }
  return true;
}

function cString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(buffer: Buffer, start: number, length: number): number {
  const slice = buffer.subarray(start, start + length);
  // GNU base-256 encoding for values that do not fit in octal.
  if (((slice[0] ?? 0) & 0x80) !== 0) {
    let value = (slice[0] ?? 0) & 0x7f;
    for (let index = 1; index < slice.length; index++) {
      value = value * 256 + (slice[index] ?? 0);
    }
    return value;
  }
  const text = cString(buffer, start, length).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function checksumValid(block: Buffer): boolean {
  const stored = octal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return sum === stored;
}

/** The `key=value` records of a PAX extended header. */
export function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(data.subarray(position, space).toString("ascii"), 10);
    if (!Number.isFinite(length) || length <= 0) {
      break;
    }
    const record = data.subarray(space + 1, position + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) {
      records.set(record.slice(0, equals), record.slice(equals + 1));
    }
    position += length;
  }
  return records;
}

function typeOf(flag: string): TarEntryType {
  switch (flag) {
    case "0":
    case "\0":
    case "7":
      return "file";
    case "5":
      return "directory";
    case "2":
      return "symlink";
    default:
      return "other";
  }
}

function bodyStream(reader: ByteReader, size: number, onDone: () => void): Readable {
  let left = size;
  async function* generate(): AsyncGenerator<Buffer> {
    try {
      while (left > 0) {
        const chunk = await reader.readSome(Math.min(left, 64 * 1024));
        if (chunk.length === 0) {
          throw new Error("tar archive ends inside an entry");
        }
        left -= chunk.length;
        yield chunk;
      }
    } finally {
      onDone();
    }
  }
  const stream = Readable.from(generate(), { objectMode: false });
  // `left` is read after the consumer is done, to skip what it did not take.
  Object.defineProperty(stream, "remaining", { get: () => left });
  return stream;
}

/** Read the entries of a tar stream. */
export async function* readTar(
  source: AsyncIterable<Buffer | Uint8Array>,
): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source);
  let pax = new Map<string, string>();
  let longName: string | null = null;
  let longLink: string | null = null;
  for (;;) {
    const header = await reader.readExact(BLOCK);
    if (header.length < BLOCK || isZeroBlock(header)) {
      return;
    }
    if (!checksumValid(header)) {
      throw new Error("tar header checksum mismatch");
    }
    const flag = String.fromCharCode(header[156] ?? 0);
    let size = octal(header, 124, 12);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
      const data = await reader.readExact(size);
      await reader.skip(padding);
      if (flag === "x") {
        pax = parsePax(data);
      } else if (flag === "L") {
        longName = cString(data, 0, data.length);
      } else if (flag === "K") {
        longLink = cString(data, 0, data.length);
      }
      continue;
    }

    const prefix = cString(header, 345, 155);
    const shortName = cString(header, 0, 100);
    let name = pax.get("path") ?? longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    const linkname = pax.get("linkpath") ?? longLink ?? cString(header, 157, 100);
    if (pax.has("size")) {
      size = Number.parseInt(pax.get("size") as string, 10);
    }
    const mtimeSeconds = pax.get("mtime") ? Number(pax.get("mtime")) : octal(header, 136, 12);
    pax = new Map();
    longName = null;
    longLink = null;

    const type = typeOf(flag);
    name = name.replace(/^\/+/, "");
    const bodySize = type === "file" ? size : 0;
    let finished = false;
    const body = bodyStream(reader, bodySize, () => {
      finished = true;
    });
    yield {
      name,
      type,
      size: bodySize,
      mode: octal(header, 100, 8),
      mtime: Number.isFinite(mtimeSeconds) ? new Date(mtimeSeconds * 1000) : null,
      linkname,
      body,
    };
    // The caller is done with the entry: skip whatever it did not read.
    const remaining = (body as unknown as { remaining: number }).remaining;
    if (!finished || remaining > 0) {
      body.destroy();
      await reader.skip(remaining);
    }
    await reader.skip((BLOCK - (bodySize % BLOCK)) % BLOCK);
  }
}
