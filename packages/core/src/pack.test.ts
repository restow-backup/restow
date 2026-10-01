import { describe, expect, it } from "vitest";
import { storedId } from "./chunkId.js";
import { type Dek, decryptChunk, encryptChunk } from "./crypto.js";
import { PackReader, PackWriter } from "./pack.js";

const tenantKey = Buffer.alloc(32, 0x05);
const dek: Dek = { version: 2, material: Buffer.alloc(32, 0x08) };

describe("pack format", () => {
  it("writes and reads a pack with a working index", () => {
    const writer = new PackWriter("tenant-abc");
    const plaintexts = [
      Buffer.from("first chunk"),
      Buffer.from("second chunk, a little longer than the first"),
      Buffer.alloc(4096, 0xab),
    ];
    const ids = plaintexts.map((p) => storedId(tenantKey, p));
    const sealed = plaintexts.map((p, i) => encryptChunk(dek, p, ids[i]));
    sealed.forEach((s, i) => writer.append(ids[i], s));

    const file = writer.finalize();
    const reader = PackReader.open(file); // verifies the content hash by default

    expect(reader.tenantId).toBe("tenant-abc");
    expect(reader.count).toBe(3);
    expect(reader.verify()).toBe(true);

    ids.forEach((id, i) => {
      expect(reader.has(id)).toBe(true);
      const got = reader.get(id);
      expect(got).toBeDefined();
      // The sealed bytes survive the round trip...
      expect((got as Buffer).equals(sealed[i])).toBe(true);
      // ...and still decrypt to the original plaintext.
      expect(decryptChunk(dek, got as Buffer).equals(plaintexts[i])).toBe(true);
    });

    const missing = storedId(tenantKey, Buffer.from("not stored"));
    expect(reader.has(missing)).toBe(false);
    expect(reader.get(missing)).toBeUndefined();
  });

  it("detects a corrupted pack", () => {
    const writer = new PackWriter("t");
    const id = storedId(tenantKey, Buffer.from("x"));
    writer.append(id, encryptChunk(dek, Buffer.from("x"), id));
    const file = writer.finalize();

    const corrupted = Buffer.from(file);
    corrupted[writer.byteLength - 1] ^= 0xff; // flip a byte inside the chunk body

    expect(() => PackReader.open(corrupted)).toThrow();
    expect(PackReader.open(corrupted, { verify: false }).verify()).toBe(false);
  });

  it("holds a stored id once and reads the first entry of older packs that repeat one", () => {
    const id = storedId(tenantKey, Buffer.from("same chunk"));
    const sealed = encryptChunk(dek, Buffer.from("same chunk"), id);
    const writer = new PackWriter("tenant-abc");
    const first = writer.append(id, sealed);
    expect(writer.append(id, encryptChunk(dek, Buffer.from("same chunk"), id))).toBe(first);
    expect(writer.count).toBe(1);
    expect(writer.has(id)).toBe(true);
    expect(PackReader.open(writer.finalize()).entries()).toHaveLength(1);

    // A pack written before duplicates were refused: two index entries, one id.
    const old = new PackWriter("tenant-abc");
    const other = storedId(tenantKey, Buffer.from("other"));
    const kept = old.append(id, sealed);
    old.append(other, encryptChunk(dek, Buffer.from("other"), other));
    const bytes = old.finalize();
    const indexOffset = Number(bytes.readBigUInt64BE(bytes.length - 8 - 32 - 16));
    // Rewrite the second index entry to name the first id again (same length).
    const secondEntry = indexOffset + 1 + id.length + 12 + 1;
    id.copy(bytes, secondEntry);
    const reader = PackReader.open(bytes, { verify: false });
    expect(reader.count).toBe(1);
    expect(reader.entries()[0]).toMatchObject({ offset: kept.offset, length: kept.length });
    expect(decryptChunk(dek, reader.get(id) as Buffer).toString()).toBe("same chunk");
  });
});
