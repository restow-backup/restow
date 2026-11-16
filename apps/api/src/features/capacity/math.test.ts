import { describe, expect, it } from "vitest";
import type { DayTotal } from "../dashboard/growth.js";
import { bucketKey, storageWindow } from "../dashboard/growth.js";
import type { StorageLimit } from "../dashboard/storage-growth.js";
import {
  chooseBasis,
  growthOf,
  limitAndFull,
  NEAR_FULL_DAYS,
  type PackFacts,
  packTotals,
  sampleSeries,
  sampleSpanDays,
} from "./math.js";

// A Wednesday.
const NOW = new Date("2026-09-23T21:30:00.000Z");
const DAY_MS = 86_400_000;

/** `count` daily totals ending today, `step` bytes more each day. */
function samples(count: number, first: number, step: number): DayTotal[] {
  const today = Date.parse("2026-09-23T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(today - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10),
    bytes: first + index * step,
  }));
}

const NO_PACKS: PackFacts = { firstWriteAt: null, totalBytes: 0, bytesAtHorizons: [0, 0, 0] };
/** Packs since 200 days ago: 1000 bytes now, 700 a week ago, 400 a month ago, 100 at 90 days. */
const PACKS: PackFacts = {
  firstWriteAt: new Date(NOW.getTime() - 200 * DAY_MS),
  totalBytes: 1000,
  bytesAtHorizons: [700, 400, 100],
};

describe("chooseBasis", () => {
  it("reads the size samples once they span a week", () => {
    expect(sampleSpanDays(samples(7, 0, 1))).toBe(7);
    expect(chooseBasis(samples(7, 0, 1), PACKS)).toBe("samples");
    expect(chooseBasis(samples(40, 0, 1), NO_PACKS)).toBe("samples");
  });

  it("falls back to the pack dates until then, and to nothing without packs", () => {
    expect(chooseBasis(samples(6, 0, 1), PACKS)).toBe("packs");
    expect(chooseBasis([], PACKS)).toBe("packs");
    expect(chooseBasis(samples(3, 0, 1), NO_PACKS)).toBe("none");
    expect(chooseBasis([], NO_PACKS)).toBe("none");
    expect(sampleSpanDays([])).toBe(0);
  });
});

describe("growthOf", () => {
  it("measures the samples over 7, 30 and 90 days and says null where the history is shorter", () => {
    const history = samples(45, 10_000, 100);
    expect(growthOf("samples", NOW, history, NO_PACKS)).toEqual({
      days7: 100,
      days30: 100,
      days90: null,
    });
  });

  it("measures the packs over the horizons the first pack is older than", () => {
    // (1000 - 700) / 7, (1000 - 400) / 30, (1000 - 100) / 90.
    expect(growthOf("packs", NOW, [], PACKS)).toEqual({ days7: 43, days30: 20, days90: 10 });
    const young: PackFacts = {
      firstWriteAt: new Date(NOW.getTime() - 20 * DAY_MS),
      totalBytes: 1000,
      bytesAtHorizons: [700, 0, 0],
    };
    expect(growthOf("packs", NOW, [], young)).toEqual({ days7: 43, days30: null, days90: null });
  });

  it("has no growth without a basis", () => {
    expect(growthOf("none", NOW, samples(10, 1, 1), PACKS)).toEqual({
      days7: null,
      days30: null,
      days90: null,
    });
  });

  it("lists the pack totals oldest first and ends with today", () => {
    expect(packTotals(NOW, PACKS)).toEqual([
      { date: "2026-06-25", bytes: 100 },
      { date: "2026-08-24", bytes: 400 },
      { date: "2026-09-16", bytes: 700 },
      { date: "2026-09-23", bytes: 1000 },
    ]);
    expect(packTotals(NOW, NO_PACKS)).toEqual([]);
  });
});

const FILESYSTEM = (freeBytes: number, otherData = false): StorageLimit => ({
  kind: "filesystem",
  space: { freeBytes, totalBytes: freeBytes * 2 },
  otherData,
});

describe("limitAndFull", () => {
  // 100 bytes more every day for 30 days.
  const series = sampleSeries(NOW, samples(30, 5000, 100));

  it("dates when the free space is used up at the growth of the estimate", () => {
    const result = limitAndFull({ limit: FILESYSTEM(5000), basis: "samples", series });
    expect(result.forecast).toMatchObject({ slopeBytesPerDay: 100, band: null });
    expect(result.limit).toEqual({
      kind: "filesystem",
      freeBytes: 5000,
      totalBytes: 10_000,
      dateWithheld: null,
    });
    expect(result.full).toEqual({
      estimate: "2026-11-12",
      earliest: null,
      latest: null,
      estimateInDays: 50,
      nearest: "2026-11-12",
      nearestInDays: 50,
    });
  });

  it("counts the restic repositories in the samples, so other data does not withhold the day", () => {
    const result = limitAndFull({ limit: FILESYSTEM(5000, true), basis: "samples", series });
    expect(result.limit.dateWithheld).toBeNull();
    expect(result.full?.estimate).toBe("2026-11-12");
  });

  it("withholds the day while the pack dates are the basis and other data is written there too", () => {
    const window = storageWindow(NOW, 30, new Date("2026-08-01T00:00:00.000Z"));
    const packs = {
      window,
      baseline: 0,
      written: window.buckets.map((bucket) => ({
        bucket: bucketKey(bucket.start, window.granularity),
        bytes: 100,
      })),
    };
    const withheld = limitAndFull({ limit: FILESYSTEM(5000, true), basis: "packs", series: packs });
    expect(withheld.limit).toMatchObject({ kind: "filesystem", dateWithheld: "other_data" });
    expect(withheld.full).toBeNull();
    // The estimate itself is still given; only the day is withheld.
    expect(withheld.forecast?.slopeBytesPerDay).toBe(100);
    const alone = limitAndFull({ limit: FILESYSTEM(5000), basis: "packs", series: packs });
    expect(alone.full?.estimateInDays).toBe(50);
  });

  it("names no day where no limit is known", () => {
    for (const kind of ["s3", "shared_default", "unknown"] as const) {
      const result = limitAndFull({
        limit: { kind, space: null, otherData: false },
        basis: "samples",
        series,
      });
      expect(result.limit).toEqual({ kind, freeBytes: null, totalBytes: null, dateWithheld: null });
      expect(result.full).toBeNull();
      expect(result.forecast).not.toBeNull();
    }
  });

  it("has no estimate without a history, and no day for a repository that does not grow", () => {
    const none = limitAndFull({ limit: FILESYSTEM(5000), basis: "none", series: null });
    expect(none).toMatchObject({ forecast: null, full: null });
    const flat = limitAndFull({
      limit: FILESYSTEM(5000),
      basis: "samples",
      series: sampleSeries(NOW, samples(30, 5000, 0)),
    });
    expect(flat.forecast?.slopeBytesPerDay).toBe(0);
    expect(flat.full).toMatchObject({ estimate: null, nearest: null, nearestInDays: null });
  });

  it("gives the day of the fastest and of the slowest growth from three months on", () => {
    // 100 days of history: 100 bytes a day for the first 50, 300 a day after.
    const history: DayTotal[] = [];
    let total = 0;
    for (const [index, date] of samples(100, 0, 0).entries()) {
      total += index < 50 ? 100 : 300;
      history.push({ date: date.date, bytes: total });
    }
    const banded = limitAndFull({
      limit: FILESYSTEM(30_000),
      basis: "samples",
      series: sampleSeries(NOW, history),
    });
    expect(banded.forecast?.band).not.toBeNull();
    expect(banded.full?.earliest).not.toBeNull();
    expect(banded.full?.latest).not.toBeNull();
    // The nearer day is the one of the fastest growth.
    expect(banded.full?.nearest).toBe(banded.full?.earliest);
    expect(banded.full?.nearestInDays).toBeLessThan(banded.full?.estimateInDays ?? 0);
  });

  it("calls a repository near full within ninety days", () => {
    expect(NEAR_FULL_DAYS).toBe(90);
  });
});
