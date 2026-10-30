import { describe, expect, it } from "vitest";
import { bucketKey, storageBuckets, storageForecast, storageWindow } from "./growth.js";
import { buildStorageGrowth } from "./storage-growth.js";

// A Wednesday.
const NOW = new Date("2026-09-23T21:30:00.000Z");
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");

/** 100 bytes written every day of a 30-day window over a baseline of 1000. */
function steady(days = 30) {
  const window = storageWindow(NOW, days, LONG_AGO);
  return {
    window,
    baseline: 1000,
    written: window.buckets.map((bucket) => ({
      bucket: bucketKey(bucket.start, window.granularity),
      bytes: 100,
    })),
  };
}

describe("buildStorageGrowth", () => {
  it("assembles the chart's figures from a series: the stored totals, the growth, the estimate", () => {
    const series = steady();
    const widget = buildStorageGrowth(series, 14, null);
    expect(widget).toMatchObject({
      days: 30,
      requestedDays: 30,
      granularity: "day",
      growthBytes: 3000,
      capacity: null,
    });
    expect(widget.series).toHaveLength(30);
    expect(widget.series[0]).toEqual({ date: "2026-08-25", bytes: 1100 });
    expect(widget.series.at(-1)).toEqual({ date: "2026-09-23", bytes: 4000 });
    // The estimate is the one the shared functions give.
    const buckets = storageBuckets(series.window, series.baseline, series.written);
    expect(widget.forecast).toEqual(storageForecast(series.window, buckets, 14));
    expect(widget.forecast?.horizonDays).toBe(14);
  });

  it("dates when the free space runs out where the repository's space is known", () => {
    const widget = buildStorageGrowth(steady(), 30, {
      freeBytes: 1000,
      totalBytes: 5000,
      otherData: false,
    });
    expect(widget.capacity).toEqual({
      source: "filesystem",
      freeBytes: 1000,
      totalBytes: 5000,
      runsFull: { estimate: "2026-10-03", earliest: null, latest: null },
    });
  });

  it("gives no day while other data is written to the repository as well", () => {
    const widget = buildStorageGrowth(steady(), 30, {
      freeBytes: 1000,
      totalBytes: 5000,
      otherData: true,
    });
    expect(widget.capacity).toMatchObject({ freeBytes: 1000, runsFull: null });
  });

  it("has no estimate and no capacity for a tenant without data", () => {
    const window = storageWindow(NOW, 30, null);
    const widget = buildStorageGrowth({ window, baseline: 0, written: [] }, 30, {
      freeBytes: 1,
      totalBytes: 2,
      otherData: false,
    });
    expect(widget.forecast).toBeNull();
    expect(widget.growthBytes).toBe(0);
    expect(widget.capacity?.runsFull).toEqual({ estimate: null, earliest: null, latest: null });
  });
});
