import { describe, expect, it } from "vitest";
import { storedId } from "../chunkId.js";
import { type Dek, encryptChunk } from "../crypto.js";
import { Keyring, deriveChunkIdKey, sealedKeyVersion } from "./keyring.js";
import { matchesSelection } from "./types.js";

const v1: Dek = { version: 1, material: Buffer.alloc(32, 0x01) };
const v2: Dek = { version: 2, material: Buffer.alloc(32, 0x02) };

describe("Keyring", () => {
  it("seals with the newest version and opens every held version", () => {
    const ring = new Keyring("tenant-a", [v2, v1]);
    expect(ring.current.version).toBe(2);
    expect(ring.versions()).toEqual([1, 2]);
    const plaintext = Buffer.from("payload");
    const id = storedId(ring.chunkIdKey, plaintext);
    const old = encryptChunk(v1, plaintext, id);
    const fresh = encryptChunk(ring.current, plaintext, id);
    expect(sealedKeyVersion(old)).toBe(1);
    expect(ring.open(old).equals(plaintext)).toBe(true);
    expect(ring.open(fresh).equals(plaintext)).toBe(true);
    expect(() => new Keyring("tenant-a", [v1]).open(fresh)).toThrow(/key version 2/);
  });

  it("derives a chunk-id key that is stable across rotation and distinct per tenant", () => {
    const before = new Keyring("tenant-a", [v1]).chunkIdKey;
    const after = new Keyring("tenant-a", [v1, v2]).chunkIdKey;
    expect(after.equals(before)).toBe(true);
    expect(before.equals(v1.material)).toBe(false);
    expect(deriveChunkIdKey("tenant-b", v1).equals(before)).toBe(false);
  });

  it("rejects empty and duplicate key sets", () => {
    expect(() => new Keyring("t", [])).toThrow(/no data-encryption key/);
    expect(() => new Keyring("t", [v1, { ...v1 }])).toThrow(/duplicate/);
  });
});

describe("matchesSelection", () => {
  const object = {
    path: "files/Documents/report.docx",
    id: "item-9",
    size: 1,
    mtime: 0,
    chunks: [],
  };

  it("matches everything for an empty or explicit all selection", () => {
    expect(matchesSelection(object, {})).toBe(true);
    expect(matchesSelection(object, { all: true, paths: ["other"] })).toBe(true);
  });

  it("matches by path, id and folder prefix", () => {
    expect(matchesSelection(object, { paths: ["files/Documents/report.docx"] })).toBe(true);
    expect(matchesSelection(object, { objectIds: ["item-9"] })).toBe(true);
    expect(matchesSelection(object, { folderPaths: ["files/Documents"] })).toBe(true);
    expect(matchesSelection(object, { folderPaths: ["files/Doc"] })).toBe(false);
    expect(matchesSelection(object, { paths: ["files/other"] })).toBe(false);
  });
});
