import { describe, expect, it } from "vitest";
import { mapBounded } from "./bounded-map.js";

describe("mapBounded", () => {
  it("keeps the order of the items and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapBounded([5, 1, 4, 2, 3, 0], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it("returns nothing for nothing", async () => {
    expect(await mapBounded([], 4, async () => 1)).toEqual([]);
  });

  it("rejects when a call rejects", async () => {
    await expect(
      mapBounded([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
