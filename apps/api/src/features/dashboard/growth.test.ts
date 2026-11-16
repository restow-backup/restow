import { describe, expect, it } from "vitest";
import {
  bucketKey,
  type DayTotal,
  growthPerDay,
  growthRange,
  historyFromTotals,
  runsFull,
  STORAGE_MIN_DAYS,
  storageBuckets,
  storageForecast,
  storageWindow,
} from "./growth.js";

// A Wednesday.
const NOW = new Date("2026-09-23T21:30:00.000Z");
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");

describe("storageWindow", () => {
  it("covers whole UTC days ending with today, per day up to a month", () => {
    const window = storageWindow(NOW, 30, LONG_AGO);
    expect(window).toMatchObject({ requestedDays: 30, days: 30, granularity: "day" });
    expect(window.start.toISOString()).toBe("2026-08-25T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(window.buckets).toHaveLength(30);
  });

  it("sums three months up per ISO week and a year per month", () => {
    const quarter = storageWindow(NOW, 90, LONG_AGO);
    expect(quarter.granularity).toBe("week");
    // 2026-06-26 (a Friday) to today: a cut week, twelve whole ones, and this week so far.
    expect(quarter.buckets).toHaveLength(14);
    const year = storageWindow(NOW, 365, LONG_AGO);
    expect(year.granularity).toBe("month");
    expect(year.buckets).toHaveLength(13);
    expect(year.buckets[0]?.t).toBe("2025-09-24");
    expect(year.buckets.at(-1)?.t).toBe("2026-09-01");
  });

  it("clamps the window to the history that exists, but not below a week", () => {
    const sixWeeks = storageWindow(NOW, 365, new Date("2026-08-13T08:00:00.000Z"));
    expect(sixWeeks).toMatchObject({ requestedDays: 365, days: 42, granularity: "week" });
    expect(sixWeeks.start.toISOString()).toBe("2026-08-13T00:00:00.000Z");
    const twoDays = storageWindow(NOW, 90, new Date("2026-09-22T10:00:00.000Z"));
    expect(twoDays.days).toBe(STORAGE_MIN_DAYS);
    const nothing = storageWindow(NOW, 30, null);
    expect(nothing.days).toBe(STORAGE_MIN_DAYS);
    // A shorter request than the history is never stretched.
    expect(storageWindow(NOW, 7, LONG_AGO).days).toBe(7);
  });
});

describe("storageBuckets", () => {
  it("keys buckets the way date_trunc does", () => {
    expect(bucketKey(new Date("2026-09-23T00:00:00.000Z"), "day")).toBe("2026-09-23");
    expect(bucketKey(new Date("2026-09-23T00:00:00.000Z"), "week")).toBe("2026-09-21");
    expect(bucketKey(new Date("2026-09-23T00:00:00.000Z"), "month")).toBe("2026-09-01");
  });

  it("adds each bucket's writes to what existed before the window, dated with its last day", () => {
    const window = storageWindow(NOW, 30, LONG_AGO);
    const buckets = storageBuckets(window, 100, [
      { bucket: "2026-08-25", bytes: 10 },
      { bucket: "2026-09-23", bytes: 5 },
    ]);
    expect(buckets[0]).toMatchObject({ date: "2026-08-25", bytes: 110, written: 10 });
    expect(buckets[1]).toMatchObject({ date: "2026-08-26", bytes: 110, written: 0 });
    expect(buckets.at(-1)).toMatchObject({ date: "2026-09-23", bytes: 115, offsetDays: 30 });
  });

  it("dates a month with its last day and the current one with today", () => {
    const window = storageWindow(NOW, 365, LONG_AGO);
    const buckets = storageBuckets(window, 0, [
      { bucket: "2025-09-01", bytes: 1 },
      { bucket: "2026-08-01", bytes: 2 },
    ]);
    expect(buckets[0]).toMatchObject({ date: "2025-09-30", bytes: 1, days: 7, complete: false });
    expect(buckets[1]).toMatchObject({ date: "2025-10-31", days: 31, complete: true });
    expect(buckets.at(-2)).toMatchObject({ date: "2026-08-31", bytes: 3, complete: true });
    expect(buckets.at(-1)).toMatchObject({ date: "2026-09-23", bytes: 3, complete: false });
  });
});

/** A year of history: 1 GB a day in winter (Oct to Mar), 3 GB a day in summer. */
function yearOfGrowth() {
  const window = storageWindow(NOW, 365, LONG_AGO);
  const GB = 1e9;
  const written = window.buckets.map((bucket) => {
    const month = bucket.start.getUTCMonth();
    const perDay = month >= 3 && month <= 8 ? 3 * GB : GB;
    const days = Math.round((bucket.end.getTime() - bucket.start.getTime()) / 86_400_000);
    return { bucket: bucketKey(bucket.start, window.granularity), bytes: perDay * days };
  });
  return { window, buckets: storageBuckets(window, 10 * GB, written), GB };
}

describe("storageForecast", () => {
  it("continues the least-squares line from today, a point per day", () => {
    const window = storageWindow(NOW, 7, LONG_AGO);
    const buckets = storageBuckets(
      window,
      0,
      window.buckets.map((bucket) => ({ bucket: bucketKey(bucket.start, "day"), bytes: 100 })),
    );
    const forecast = storageForecast(window, buckets, 7);
    expect(forecast).toMatchObject({
      method: "linear",
      basisDays: 7,
      slopeBytesPerDay: 100,
      horizonDays: 7,
      band: null,
    });
    expect(forecast?.points[0]).toEqual({ date: "2026-09-24", bytes: 800 });
    expect(forecast?.points).toHaveLength(7);
    expect(forecast?.points.at(-1)).toEqual({ date: "2026-09-30", bytes: 1400 });
  });

  it("looks no further ahead than the history it rests on", () => {
    const window = storageWindow(NOW, 365, new Date("2026-08-13T00:00:00.000Z"));
    const buckets = storageBuckets(window, 0, [{ bucket: "2026-08-10", bytes: 500 }]);
    const forecast = storageForecast(window, buckets, 365);
    expect(forecast?.horizonDays).toBe(42);
    // Weekly points, the last one exactly at the horizon.
    expect(forecast?.points.map((point) => point.date)).toEqual([
      "2026-09-30",
      "2026-10-07",
      "2026-10-14",
      "2026-10-21",
      "2026-10-28",
      "2026-11-04",
    ]);
  });

  it("gives a band between the slowest and fastest month from three months on", () => {
    const { window, buckets, GB } = yearOfGrowth();
    const forecast = storageForecast(window, buckets, 365);
    expect(forecast?.band?.slowestBytesPerDay).toBe(GB);
    expect(forecast?.band?.fastestBytesPerDay).toBe(3 * GB);
    expect(forecast?.points).toHaveLength(13);
    const last = buckets.at(-1)?.bytes ?? 0;
    expect(forecast?.band?.points.at(-1)).toEqual({
      date: "2027-09-23",
      low: last + 365 * GB,
      high: last + 365 * 3 * GB,
    });
    for (const [index, point] of (forecast?.band?.points ?? []).entries()) {
      const line = forecast?.points[index]?.bytes ?? 0;
      expect(point.low).toBeLessThanOrEqual(line);
      expect(point.high).toBeGreaterThanOrEqual(line);
    }
    // A month of history draws a line only.
    const month = storageWindow(NOW, 30, LONG_AGO);
    const monthly = storageBuckets(month, 1, [{ bucket: "2026-09-01", bytes: 10 }]);
    expect(storageForecast(month, monthly, 30)?.band).toBeNull();
  });

  it("leaves the first and the current bucket out of the band, which are cut short", () => {
    const { buckets } = yearOfGrowth();
    const range = growthRange([
      { ...(buckets[0] as (typeof buckets)[number]), written: 0 },
      ...buckets.slice(1),
    ]);
    expect(range?.slowest).toBe(1e9);
  });

  it("offers nothing to extrapolate from an empty history", () => {
    const window = storageWindow(NOW, 30, null);
    expect(storageForecast(window, storageBuckets(window, 0, []), 30)).toBeNull();
    expect(storageForecast(window, [], 30)).toBeNull();
  });
});

describe("runsFull", () => {
  it("dates when the free space is used up at the line's growth", () => {
    const window = storageWindow(NOW, 7, LONG_AGO);
    const buckets = storageBuckets(
      window,
      0,
      window.buckets.map((bucket) => ({ bucket: bucketKey(bucket.start, "day"), bytes: 100 })),
    );
    const forecast = storageForecast(window, buckets, 7);
    expect(runsFull("2026-09-23", 1000, forecast)).toEqual({
      estimate: "2026-10-03",
      earliest: null,
      latest: null,
    });
    // More than ten years ahead is no date.
    expect(runsFull("2026-09-23", 100 * 3651, forecast).estimate).toBeNull();
    expect(runsFull("2026-09-23", 1000, null)).toEqual({
      estimate: null,
      earliest: null,
      latest: null,
    });
  });

  it("dates the earliest day by the fastest growth and the latest by the slowest", () => {
    const { window, buckets, GB } = yearOfGrowth();
    const forecast = storageForecast(window, buckets, 365);
    expect(runsFull("2026-09-23", 300 * GB, forecast)).toMatchObject({
      earliest: "2027-01-01",
      latest: "2027-07-20",
    });
  });
});

/** `count` daily totals ending with `lastDate`, each `step` bytes above the day before. */
function dailyTotals(lastDate: string, count: number, first: number, step: number): DayTotal[] {
  const end = Date.parse(`${lastDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(end - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10),
    bytes: first + index * step,
  }));
}

describe("historyFromTotals", () => {
  it("starts the window at the first measurement, not at zero", () => {
    const totals = dailyTotals("2026-09-23", 14, 1000, 100);
    const series = historyFromTotals(NOW, 90, totals);
    // Two weeks of history: the window is those fourteen days, the baseline the first total.
    expect(series.window.days).toBe(14);
    expect(series.baseline).toBe(1000);
    const buckets = storageBuckets(series.window, series.baseline, series.written);
    expect(buckets.at(-1)?.bytes).toBe(1000 + 13 * 100);
    expect(storageForecast(series.window, buckets, 30)?.slopeBytesPerDay).toBe(100);
  });

  it("carries the total over a day without a measurement", () => {
    const totals: DayTotal[] = [
      { date: "2026-09-10", bytes: 100 },
      { date: "2026-09-12", bytes: 300 },
      { date: "2026-09-23", bytes: 1400 },
    ];
    const series = historyFromTotals(NOW, 14, totals);
    const buckets = storageBuckets(series.window, series.baseline, series.written);
    expect(buckets.find((bucket) => bucket.date === "2026-09-11")?.bytes).toBe(100);
    expect(buckets.find((bucket) => bucket.date === "2026-09-12")?.bytes).toBe(300);
    expect(buckets.at(-1)?.bytes).toBe(1400);
  });

  it("takes the last total before the window as its baseline and lets a total fall", () => {
    const totals: DayTotal[] = [
      { date: "2026-06-01", bytes: 500 },
      { date: "2026-09-01", bytes: 900 },
      { date: "2026-09-10", bytes: 700 },
      { date: "2026-09-23", bytes: 800 },
    ];
    // The window of 14 days starts on 2026-09-10; the 9 September total is its baseline.
    const series = historyFromTotals(NOW, 14, totals);
    expect(series.window.start.toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(series.baseline).toBe(900);
    const buckets = storageBuckets(series.window, series.baseline, series.written);
    expect(buckets[0]?.bytes).toBe(700);
    expect(buckets.at(-1)?.bytes).toBe(800);
    // Pruning shrank the total in the first bucket: the estimate never goes below zero.
    expect(storageForecast(series.window, buckets, 14)?.slopeBytesPerDay).toBeGreaterThanOrEqual(0);
  });

  it("is empty without a measurement", () => {
    const series = historyFromTotals(NOW, 90, []);
    expect(series).toMatchObject({ baseline: 0, written: [] });
    expect(series.window.days).toBe(STORAGE_MIN_DAYS);
  });
});

describe("growthPerDay", () => {
  const totals = dailyTotals("2026-09-23", 40, 1000, 50);

  it("is the change per day between the newest total and the one that many days back", () => {
    expect(growthPerDay(totals, "2026-09-23", 7)).toBe(50);
    expect(growthPerDay(totals, "2026-09-23", 30)).toBe(50);
  });

  it("is null while the history does not reach back that far", () => {
    expect(growthPerDay(totals, "2026-09-23", 90)).toBeNull();
    expect(growthPerDay(dailyTotals("2026-09-23", 1, 5, 0), "2026-09-23", 7)).toBeNull();
    expect(growthPerDay([], "2026-09-23", 7)).toBeNull();
  });

  it("measures over the real distance when the reference day has no total", () => {
    const sparse: DayTotal[] = [
      { date: "2026-09-10", bytes: 1000 },
      { date: "2026-09-22", bytes: 2200 },
    ];
    // The newest total is yesterday's; the one on or before the 16th is the 10th: 12 days apart.
    expect(growthPerDay(sparse, "2026-09-23", 7)).toBe(100);
  });

  it("is negative when the total fell and ignores totals from the future", () => {
    const falling: DayTotal[] = [
      { date: "2026-09-15", bytes: 800 },
      { date: "2026-09-23", bytes: 400 },
      { date: "2026-09-25", bytes: 9999 },
    ];
    expect(growthPerDay(falling, "2026-09-23", 8)).toBe(-50);
  });
});
