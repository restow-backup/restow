import { type BlockMap, emptyBlockMap } from "@restow/core";
import { describe, expect, it } from "vitest";
import { BlockMapCache, blockMapBytes } from "./store.js";

const MIB = 1024 * 1024;

/** A map of `blocks` 4 MiB blocks, each stored as `refs` chunks. */
function mapOf(blocks: number, refs = 1): BlockMap {
  const map = emptyBlockMap(blocks * 4 * MIB);
  for (const entry of map.entries) {
    entry.chunks = Array.from({ length: refs }, (_, i) => `${i}`.padStart(64, "c"));
  }
  return map;
}

describe("block map cache", () => {
  it("estimates a 2 TB disk's map at about 200 MB", () => {
    expect(blockMapBytes(mapOf(1000, 2))).toBe(64 + 1000 * 400);
    // 2 TB in 4 MiB blocks of two chunks each.
    const bytes = blockMapBytes(mapOf((2 * 1024 * 1024) / 4, 2));
    expect(bytes).toBeGreaterThan(150 * MIB);
    expect(bytes).toBeLessThan(250 * MIB);
  });

  it("evicts the least recently used maps by size, not by count", () => {
    const cache = new BlockMapCache(1000);
    const map = mapOf(1);
    cache.set("a", map, 400);
    cache.set("b", map, 400);
    expect(cache.bytes).toBe(800);
    // Reading `a` makes `b` the oldest.
    expect(cache.get("a")).toBe(map);
    cache.set("c", map, 400);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(map);
    expect(cache.bytes).toBe(800);
    // Many small maps fit where two large ones did.
    cache.clear();
    for (let i = 0; i < 50; i++) {
      cache.set(`small-${i}`, map, 10);
    }
    expect(cache.size).toBe(50);
    expect(cache.bytes).toBe(500);
    // Replacing a map counts it once.
    cache.set("small-49", map, 20);
    expect(cache.bytes).toBe(510);
  });

  it("keeps a map larger than the budget alone", () => {
    const cache = new BlockMapCache(1000);
    const map = mapOf(1);
    cache.set("a", map, 400);
    cache.set("huge", map, 5000);
    expect(cache.size).toBe(1);
    expect(cache.get("huge")).toBe(map);
    cache.set("b", map, 400);
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.bytes).toBe(400);
  });
});
