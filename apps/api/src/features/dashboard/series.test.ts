import { describe, expect, it } from "vitest";
import { dayKeys, fillDays, leastSquaresSlope, utcDayKey, windowStart } from "./series.js";

const NOW = new Date("2026-09-23T21:30:00.000Z");

describe("day keys", () => {
  it("counts whole UTC days ending with today, oldest first", () => {
    expect(windowStart(NOW, 3).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(dayKeys(NOW, 3)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);
    expect(dayKeys(NOW, 30)).toHaveLength(30);
    expect(dayKeys(NOW, 30)[0]).toBe("2026-08-25");
  });

  it("uses the UTC day, not the server's local one", () => {
    expect(utcDayKey(new Date("2026-09-23T23:59:59.000Z"))).toBe("2026-09-23");
    expect(utcDayKey(new Date("2026-09-24T00:00:00.000Z"))).toBe("2026-09-24");
  });

  it("crosses month and year boundaries", () => {
    expect(dayKeys(new Date("2027-01-01T08:00:00.000Z"), 2)).toEqual(["2026-12-31", "2027-01-01"]);
  });
});

describe("fillDays", () => {
  it("fills days without activity and drops rows outside the window", () => {
    const keys = ["2026-09-21", "2026-09-22", "2026-09-23"];
    const rows = [
      { date: "2026-09-22", n: 4 },
      { date: "2026-09-01", n: 9 },
    ];
    expect(fillDays(keys, rows, (date) => ({ date, n: 0 }))).toEqual([
      { date: "2026-09-21", n: 0 },
      { date: "2026-09-22", n: 4 },
      { date: "2026-09-23", n: 0 },
    ]);
  });
});

describe("leastSquaresSlope", () => {
  it("fits the slope by least squares", () => {
    expect(leastSquaresSlope([0, 10, 20, 30])).toBe(10);
    expect(leastSquaresSlope([5, 5, 5])).toBe(0);
    expect(leastSquaresSlope([7])).toBe(0);
  });

  it("fits over the given positions when the steps are uneven", () => {
    // Bytes at the end of buckets of 3, 7 and 7 days: 10 bytes a day throughout.
    expect(leastSquaresSlope([30, 100, 170], [3, 10, 17])).toBeCloseTo(10);
    expect(leastSquaresSlope([1, 2], [4, 4])).toBe(0);
  });
});
