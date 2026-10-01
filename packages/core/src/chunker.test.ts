import { describe, expect, it } from "vitest";
import { AVG_CHUNK_SIZE, MAX_CHUNK_SIZE, MIN_CHUNK_SIZE, chunk, chunkAll } from "./chunker.js";

// A committed, deterministic pseudo-random source so the "reference vector" inputs
// are identical on every machine without shipping large binary fixtures.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function referenceBuffer(size: number, seed: number): Buffer {
  const rng = mulberry32(seed);
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    buf[i] = Math.floor(rng() * 256) & 0xff;
  }
  return buf;
}

describe("FastCDC chunker", () => {
  it("treats an empty buffer as no chunks", () => {
    expect(chunkAll(Buffer.alloc(0))).toEqual([]);
  });

  it("emits a single chunk for objects smaller than the minimum", () => {
    const buf = referenceBuffer(1000, 1);
    expect(chunkAll(buf)).toEqual([{ offset: 0, length: 1000 }]);
  });

  it("emits a single chunk for an object exactly at the minimum size", () => {
    const buf = referenceBuffer(MIN_CHUNK_SIZE, 2);
    expect(chunkAll(buf)).toEqual([{ offset: 0, length: MIN_CHUNK_SIZE }]);
  });

  it("is deterministic and depends only on content, not identity", () => {
    const a = referenceBuffer(5 * 1024 * 1024, 3);
    const b = Buffer.from(a); // independent buffer, identical bytes
    expect(chunkAll(a)).toEqual(chunkAll(b));
  });

  it("agrees between the generator and the array helper", () => {
    const buf = referenceBuffer(3 * 1024 * 1024, 7);
    expect([...chunk(buf)]).toEqual(chunkAll(buf));
  });

  it("respects min/max bounds and fully partitions the input (reference vector)", () => {
    const size = 8 * 1024 * 1024; // 8 MiB, seed 42
    const buf = referenceBuffer(size, 42);
    const chunks = chunkAll(buf);

    // With avg 1 MiB and max 4 MiB, an 8 MiB object needs at least 2 chunks and,
    // since every non-final chunk is >= 256 KiB, at most ~32.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(40);

    let cursor = 0;
    const parts: Buffer[] = [];
    chunks.forEach((c, index) => {
      expect(c.offset).toBe(cursor);
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
      if (index < chunks.length - 1) {
        expect(c.length).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE);
      }
      parts.push(buf.subarray(c.offset, c.offset + c.length));
      cursor += c.length;
    });

    expect(cursor).toBe(size);
    expect(Buffer.concat(parts).equals(buf)).toBe(true);
    expect(AVG_CHUNK_SIZE).toBe(1024 * 1024);
  });
});
