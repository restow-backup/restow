import { describe, expect, it } from "vitest";

import { byteTicks, seriesForRange, usageDateLabel } from "./usage";

describe("usage helpers", () => {
  it("takes the tail of the series for a range", () => {
    const series = Array.from({ length: 90 }, (_, index) => ({ date: `d${index}`, bytes: index }));
    expect(seriesForRange(series, 30)).toHaveLength(30);
    expect(seriesForRange(series, 30)[0]?.bytes).toBe(60);
    expect(seriesForRange(series, 90)).toHaveLength(90);
  });

  it("formats series days in UTC and the UI language", () => {
    expect(usageDateLabel("2026-09-23", "en", "long")).toBe("September 23, 2026");
    expect(usageDateLabel("2026-09-23", "de", "long")).toBe("23. September 2026");
    expect(usageDateLabel("not a day", "en", "short")).toBe("not a day");
  });
});

describe("byteTicks", () => {
  const GIB = 1024 ** 3;

  it("steps in round binary units", () => {
    expect(byteTicks(126 * GIB)).toEqual([0, 50 * GIB, 100 * GIB, 150 * GIB]);
    expect(byteTicks(3.5 * 1024 ** 4)).toEqual([
      0,
      1024 ** 4,
      2 * 1024 ** 4,
      3 * 1024 ** 4,
      4 * 1024 ** 4,
    ]);
    expect(byteTicks(900 * 1024 ** 2)).toEqual([
      0,
      250 * 1024 ** 2,
      500 * 1024 ** 2,
      750 * 1024 ** 2,
      1000 * 1024 ** 2,
    ]);
  });

  it("handles tiny and empty stores", () => {
    expect(byteTicks(0)).toEqual([0]);
    expect(byteTicks(3)).toEqual([0, 1, 2, 3]);
  });
});
