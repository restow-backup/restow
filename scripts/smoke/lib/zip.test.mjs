import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { parseSha256Sums, readZip } from "./zip.mjs";

/** A minimal ZIP writer for the test: stored or deflated entries. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = deflate ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

test("readZip reads stored and deflated entries, directories and UTF-8 names", () => {
  const zip = makeZip([
    { name: "a.eml", data: Buffer.from("Subject: a\r\n\r\nbody"), deflate: true },
    { name: "Ordner/", data: Buffer.alloc(0) },
    { name: "Ordner/grüße.eml", data: Buffer.from("x".repeat(3000)), deflate: false },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.data.length]),
    [
      ["a.eml", 18],
      ["Ordner/", 0],
      ["Ordner/grüße.eml", 3000],
    ],
  );
  assert.equal(entries[0].data.toString(), "Subject: a\r\n\r\nbody");
});

test("readZip refuses what is not a ZIP", () => {
  assert.throws(() => readZip(Buffer.from("not a zip at all, just text")), /not a ZIP/u);
});

test("parseSha256Sums reads sha256sum output", () => {
  const hash = "a".repeat(64);
  const sums = parseSha256Sums(`${hash}  mail/INBOX/1.eml\n${hash} *b.eml\nnonsense\n`);
  assert.equal(sums.get("mail/INBOX/1.eml"), hash);
  assert.equal(sums.get("b.eml"), hash);
  assert.equal(sums.size, 2);
});

test("readZip follows ZIP64 end records and ZIP64 extra fields", () => {
  const data = Buffer.from("zip64 entry body");
  const nameBytes = Buffer.from("big.eml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(0xffffffff, 18);
  local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(45, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(28, 30);
  central.writeUInt32LE(0xffffffff, 42);
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(data.length), 4);
  extra.writeBigUInt64LE(BigInt(data.length), 12);
  extra.writeBigUInt64LE(0n, 20);
  const body = Buffer.concat([local, nameBytes, data]);
  const centralAll = Buffer.concat([central, nameBytes, extra]);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(1n, 24);
  record.writeBigUInt64LE(1n, 32);
  record.writeBigUInt64LE(BigInt(centralAll.length), 40);
  record.writeBigUInt64LE(BigInt(body.length), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(body.length + centralAll.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  const entries = readZip(Buffer.concat([body, centralAll, record, locator, end]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "big.eml");
  assert.equal(entries[0].data.toString(), "zip64 entry body");
});
