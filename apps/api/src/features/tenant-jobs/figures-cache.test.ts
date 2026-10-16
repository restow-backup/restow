import { describe, expect, it } from "vitest";
import { TenantFiguresCache } from "./figures-cache.js";

describe("TenantFiguresCache", () => {
  function setup() {
    let now = 0;
    const cache = new TenantFiguresCache<number>(30_000, () => now);
    const reads: string[] = [];
    const load = (tenantId: string, value: number) => () => {
      reads.push(tenantId);
      return Promise.resolve(value);
    };
    return { cache, reads, load, advance: (ms: number) => (now += ms) };
  }

  it("reads a tenant once while its figures are fresh, for every viewer", async () => {
    const { cache, reads, load, advance } = setup();
    expect(await cache.get("a", load("a", 1))).toBe(1);
    advance(29_999);
    expect(await cache.get("a", load("a", 2))).toBe(1);
    advance(1);
    expect(await cache.get("a", load("a", 3))).toBe(3);
    expect(reads).toEqual(["a", "a"]);
  });

  it("keeps tenants apart", async () => {
    const { cache, load } = setup();
    expect(await cache.get("a", load("a", 1))).toBe(1);
    expect(await cache.get("b", load("b", 2))).toBe(2);
    expect(await cache.get("a", load("a", 3))).toBe(1);
  });

  it("shares a read under way and forgets one that failed", async () => {
    const { cache, reads, load } = setup();
    const failing = () => {
      reads.push("a");
      return Promise.reject(new Error("down"));
    };
    const first = cache.get("a", failing);
    const second = cache.get("a", load("a", 1));
    await expect(first).rejects.toThrow("down");
    await expect(second).rejects.toThrow("down");
    expect(await cache.get("a", load("a", 2))).toBe(2);
    expect(reads).toEqual(["a", "a"]);
  });

  it("prunes what is too old", async () => {
    const { cache, load, advance } = setup();
    await cache.get("a", load("a", 1));
    advance(20_000);
    await cache.get("b", load("b", 2));
    advance(10_000);
    cache.prune();
    expect(cache.size).toBe(1);
  });
});
