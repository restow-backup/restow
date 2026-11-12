/**
 * The probe's DBX (docs/BAREMETAL.md 12.3): the union of the revocation updates the lab image
 * carries, as one update file `virt-fw-vars --set-dbx` takes. Built here from small updates of
 * the same shape (the real files are checked with virt-fw-vars when the image is built).
 */
import { describe, expect, it } from "vitest";
import { dbxCount, guidBytes, parseDbxUpdate, unionDbx } from "./dbx.js";

const SHA256 = guidBytes("c1c41626-504c-4092-aca9-41f936934328");
const X509 = guidBytes("a5c059a1-94e4-4aa7-87b5-ab155c2bf072");
const OWNER = guidBytes("77fa9abd-0359-4d32-bd60-28f4e78f784b");
const PKCS7 = guidBytes("4aafd29d-68df-49ee-8aa9-347d375665a7");

function time(year: number, month: number): Buffer {
  const t = Buffer.alloc(16);
  t.writeUInt16LE(year, 0);
  t[2] = month;
  t[3] = 1;
  return t;
}

function list(type: Buffer, entries: Buffer[], size: number): Buffer {
  const head = Buffer.alloc(28);
  type.copy(head, 0);
  head.writeUInt32LE(28 + entries.length * size, 16);
  head.writeUInt32LE(0, 20);
  head.writeUInt32LE(size, 24);
  return Buffer.concat([head, ...entries.map((data) => Buffer.concat([OWNER, data]))]);
}

function update(at: Buffer, lists: Buffer[], certBytes = 100): Buffer {
  const cert = Buffer.alloc(24 + certBytes);
  cert.writeUInt32LE(24 + certBytes, 0);
  cert.writeUInt16LE(0x0200, 4);
  cert.writeUInt16LE(0x0ef1, 6);
  PKCS7.copy(cert, 8);
  return Buffer.concat([at, cert, ...lists]);
}

const hash = (n: number) => Buffer.alloc(32, n);

describe("the DBX of the probe", () => {
  it("joins the updates: every revocation once, the newest time stamp, a header virt-fw-vars reads", () => {
    const older = update(time(2023, 5), [list(SHA256, [hash(1), hash(2), hash(3)], 48)]);
    const newer = update(time(2025, 2), [
      list(SHA256, [hash(3), hash(4)], 48),
      list(X509, [Buffer.alloc(40, 9)], 56),
    ]);
    const union = unionDbx([older, newer]);
    expect(dbxCount(union)).toBe(5);
    const parsed = parseDbxUpdate(union);
    expect(parsed.time.readUInt16LE(0)).toBe(2025);
    expect(parsed.lists.map((l) => l.signatures.length)).toEqual([4, 1]);
    expect(parsed.lists[0]?.signatures.map((s) => s[16])).toEqual([1, 2, 3, 4]);
    // No certificate: the store is written offline, nothing checks a signature.
    expect(union.readUInt32LE(16)).toBe(24);
    expect(union.subarray(24, 40).equals(PKCS7)).toBe(true);
    // Twice is once.
    expect(dbxCount(unionDbx([union, union]))).toBe(5);
  });

  it("refuses what is no signed update or is cut off", () => {
    const good = update(time(2024, 1), [list(SHA256, [hash(1)], 48)]);
    expect(() => parseDbxUpdate(good.subarray(0, 30))).toThrow(/too short/);
    const noPkcs7 = Buffer.from(good);
    noPkcs7[30] ^= 0xff;
    expect(() => parseDbxUpdate(noPkcs7)).toThrow(/PKCS#7/);
    expect(() => parseDbxUpdate(good.subarray(0, good.length - 10))).toThrow(/size|cut off/);
    expect(() => unionDbx([])).toThrow(/no DBX/);
  });
});
