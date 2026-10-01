/**
 * A reader for the ZIP files the mail export writes (stored and deflated
 * entries, ZIP64 records when the writer streams): enough to open an export in
 * the smoke and compare what is inside with what was put in. Independent of
 * Restow's own ZIP code on purpose.
 */
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The entries of a ZIP as `{ name, data }`; directories (names ending in "/") have empty data. */
export function readZip(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65_535); at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD) {
      end = at;
      break;
    }
  }
  if (end === -1) {
    throw new Error("not a ZIP file: no end of central directory record");
  }
  let count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    // ZIP64: the real values sit in the ZIP64 end record the locator points at.
    const locator = end - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== LOCATOR64) {
      throw new Error("ZIP64 archive without a ZIP64 end record locator");
    }
    const record = Number(buffer.readBigUInt64LE(locator + 8));
    if (buffer.readUInt32LE(record) !== EOCD64) {
      throw new Error("bad ZIP64 end of central directory record");
    }
    count = Number(buffer.readBigUInt64LE(record + 32));
    offset = Number(buffer.readBigUInt64LE(record + 48));
  }
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) {
      throw new Error(`bad central directory record ${index}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    let compressed = buffer.readUInt32LE(offset + 20);
    let uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    // ZIP64 extra field (id 1): the values that did not fit, in this order.
    let extra = offset + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra);
      const size = buffer.readUInt16LE(extra + 2);
      if (id === 1) {
        let at = extra + 4;
        if (uncompressed === 0xffffffff) {
          uncompressed = Number(buffer.readBigUInt64LE(at));
          at += 8;
        }
        if (compressed === 0xffffffff) {
          compressed = Number(buffer.readBigUInt64LE(at));
          at += 8;
        }
        if (local === 0xffffffff) {
          local = Number(buffer.readBigUInt64LE(at));
        }
      }
      extra += 4 + size;
    }
    offset += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(local) !== LOCAL) {
      throw new Error(`bad local header for ${name}`);
    }
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`${name}: unsupported compression method ${method}`);
    }
    if (data.length !== uncompressed) {
      throw new Error(`${name}: ${data.length} bytes, the archive says ${uncompressed}`);
    }
    entries.push({ name, data });
  }
  return entries;
}

/** `{ path -> sha256 }` of a `sha256sum`-style file (`<hash>  <path>` per line). */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line.trim());
    if (match) {
      sums.set(match[2], match[1]);
    }
  }
  return sums;
}
