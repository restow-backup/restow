/**
 * A minimal ZIP reader for tests: walks the central directory of an in-memory
 * archive and inflates each entry. Enough to verify what the download restore
 * produced; not a general-purpose implementation (no ZIP64, no encryption).
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly crc32: number;
  readonly modified: Date;
  readonly data: Buffer;
}

function dosDateTime(time: number, date: number): Date {
  const seconds = (time & 0x1f) * 2;
  const minutes = (time >> 5) & 0x3f;
  const hours = (time >> 11) & 0x1f;
  const day = date & 0x1f;
  const month = ((date >> 5) & 0x0f) - 1;
  const year = ((date >> 9) & 0x7f) + 1980;
  return new Date(year, month, day, hours, minutes, seconds);
}

export function readZip(archive: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0; i--) {
    if (archive.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("not a ZIP archive (no end-of-central-directory record)");
  }
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`bad central directory entry at ${offset}`);
    }
    const method = archive.readUInt16LE(offset + 10);
    const time = archive.readUInt16LE(offset + 12);
    const date = archive.readUInt16LE(offset + 14);
    const crc32 = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;

    if (archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`bad local header for ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`unsupported compression method ${method} for ${name}`);
    }
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      size,
      crc32,
      modified: dosDateTime(time, date),
      data,
    });
  }
  return entries;
}

/** Parse the RFC 4180 CSV the download restore writes (no embedded newlines in fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quoted) {
        if (char === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          field += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ",") {
        fields.push(field);
        field = "";
      } else {
        field += char;
      }
    }
    fields.push(field);
    rows.push(fields);
  }
  return rows;
}
