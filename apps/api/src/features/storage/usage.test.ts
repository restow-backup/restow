import { describe, expect, it } from "vitest";
import {
  SERIES_DAYS,
  buildGrowthSeries,
  buildUsage,
  growthOver,
  utcDay,
  windowStart,
} from "./usage.js";

const NOW = new Date("2026-09-23T15:30:00.000Z");
const GIB = 1024 ** 3;

describe("windowStart", () => {
  it("starts at midnight UTC, days - 1 before today", () => {
    expect(windowStart(NOW, 1).toISOString()).toBe("2026-09-23T00:00:00.000Z");
    expect(windowStart(NOW, 30).toISOString()).toBe("2026-08-25T00:00:00.000Z");
    expect(utcDay(windowStart(NOW, 91))).toBe("2026-06-25");
  });
});

describe("buildGrowthSeries", () => {
  it("accumulates daily additions on top of what existed before the window", () => {
    const series = buildGrowthSeries({
      totalBytes: 100,
      daily: [
        { day: "2026-09-21", bytes: 10 },
        { day: "2026-09-23", bytes: 5 },
      ],
      today: NOW,
      days: 4,
    });
    expect(series).toEqual([
      { date: "2026-09-20", bytes: 85 },
      { date: "2026-09-21", bytes: 95 },
      { date: "2026-09-22", bytes: 95 },
      { date: "2026-09-23", bytes: 100 },
    ]);
  });

  it("ignores days outside the window and never goes negative", () => {
    const series = buildGrowthSeries({
      totalBytes: 10,
      daily: [
        { day: "2026-01-01", bytes: 999 },
        { day: "2026-09-23", bytes: 50 },
      ],
      today: NOW,
      days: 2,
    });
    expect(series).toEqual([
      { date: "2026-09-22", bytes: 0 },
      { date: "2026-09-23", bytes: 10 },
    ]);
  });

  it("covers 90 days by default, ending today", () => {
    const series = buildGrowthSeries({ totalBytes: 0, daily: [], today: NOW });
    expect(series).toHaveLength(SERIES_DAYS);
    expect(series.at(-1)?.date).toBe("2026-09-23");
  });
});

describe("growthOver", () => {
  it("measures additions from the day before the window", () => {
    const series = [
      { date: "d1", bytes: 100 },
      { date: "d2", bytes: 150 },
      { date: "d3", bytes: 200 },
    ];
    expect(growthOver(series, 2)).toEqual({ days: 2, addedBytes: 100, ratio: 1 });
    expect(growthOver(series, 1)).toEqual({ days: 1, addedBytes: 50, ratio: 50 / 150 });
  });

  it("has no ratio for a store that was empty", () => {
    const series = [
      { date: "d1", bytes: 0 },
      { date: "d2", bytes: 30 },
    ];
    expect(growthOver(series, 1)).toEqual({ days: 1, addedBytes: 30, ratio: null });
    expect(growthOver([], 30)).toEqual({ days: 30, addedBytes: 0, ratio: null });
  });
});

describe("buildUsage", () => {
  it("reports 30- and 90-day growth and a 90-day series", () => {
    const usage = buildUsage(
      {
        logicalBytes: 40 * GIB,
        retainedLogicalBytes: 400 * GIB,
        physicalBytes: 60 * GIB,
        packCount: 1000,
        snapshotCount: 120,
        protectedObjectCount: 12,
      },
      [
        { day: "2026-07-01", bytes: 10 * GIB },
        { day: "2026-09-10", bytes: 5 * GIB },
      ],
      NOW,
    );
    expect(usage.series).toHaveLength(SERIES_DAYS);
    expect(usage.series.at(-1)).toEqual({ date: "2026-09-23", bytes: 60 * GIB });
    expect(usage.series[0]).toEqual({ date: "2026-06-26", bytes: 45 * GIB });
    expect(usage.growth.days30).toEqual({ days: 30, addedBytes: 5 * GIB, ratio: 5 / 55 });
    expect(usage.growth.days90).toEqual({ days: 90, addedBytes: 15 * GIB, ratio: 15 / 45 });
    expect(usage.generatedAt).toBe(NOW.toISOString());
    expect(usage.logicalBytes).toBe(40 * GIB);
  });
});
