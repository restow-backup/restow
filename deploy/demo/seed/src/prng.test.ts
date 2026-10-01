import { describe, expect, it } from "vitest";
import { chance, mulberry32, pick, randomInt, seedFrom } from "./prng.js";

describe("mulberry32", () => {
  it("is deterministic: the same seed produces the same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it("stays within [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("seedFrom", () => {
  it("is deterministic for the same text", () => {
    expect(seedFrom("info@example.org")).toBe(seedFrom("info@example.org"));
  });

  it("differs for different text (no trivial collisions in this small sample)", () => {
    const seeds = new Set(
      ["info@example.org", "accounting@example.org", "sales@example.org"].map(seedFrom),
    );
    expect(seeds.size).toBe(3);
  });
});

describe("randomInt", () => {
  it("stays within the inclusive bounds and covers them over many draws", () => {
    const rng = mulberry32(123);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const value = randomInt(rng, 1, 5);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(5);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("pick", () => {
  it("always returns one of the given items", () => {
    const rng = mulberry32(9);
    const items = ["a", "b", "c"] as const;
    for (let i = 0; i < 100; i++) {
      expect(items).toContain(pick(rng, items));
    }
  });

  it("refuses an empty list", () => {
    expect(() => pick(mulberry32(1), [])).toThrow();
  });
});

describe("chance", () => {
  it("is always true at p=1 and always false at p=0", () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      expect(chance(rng, 1)).toBe(true);
      expect(chance(rng, 0)).toBe(false);
    }
  });
});
