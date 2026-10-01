import type { StorageForecastDto, StoragePointDto } from "./dto.js";

/**
 * Pure helpers for the dashboard's day series: UTC day keys, gap filling,
 * running totals and the linear storage forecast. The queries return only the
 * days that had activity; these helpers turn them into a complete series the
 * charts can plot without guessing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of the UTC day `date` falls on. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight (UTC) of the first day of a `days`-day window ending with today. */
export function windowStart(now: Date, days: number): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS);
}

/** The `days` UTC day keys ending with today, oldest first. */
export function dayKeys(now: Date, days: number): string[] {
  const start = windowStart(now, days).getTime();
  return Array.from({ length: days }, (_, index) => utcDayKey(new Date(start + index * DAY_MS)));
}

/**
 * One entry per day of the window: the row the query returned for that day,
 * or `empty(date)` for a day without activity. Rows outside the window are
 * dropped.
 */
export function fillDays<T extends { date: string }>(
  keys: readonly string[],
  rows: readonly T[],
  empty: (date: string) => T,
): T[] {
  const byDay = new Map(rows.map((row) => [row.date, row]));
  return keys.map((date) => byDay.get(date) ?? empty(date));
}

/**
 * Bytes stored at the end of each day: what existed before the window plus
 * everything written up to and including that day.
 */
export function runningTotals(
  keys: readonly string[],
  baseline: number,
  written: readonly { date: string; bytes: number }[],
): StoragePointDto[] {
  const byDay = new Map(written.map((row) => [row.date, row.bytes]));
  let total = baseline;
  return keys.map((date) => {
    total += byDay.get(date) ?? 0;
    return { date, bytes: total };
  });
}

/** Least-squares slope of `values` over their index (units per step); 0 for fewer than two values. */
export function leastSquaresSlope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) {
    return 0;
  }
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * A straight-line projection of the stored bytes for `horizonDays` after the
 * series: the least-squares slope of the series, continued from its last
 * value (so the projection joins the measured line) and never below zero.
 * Null when there is nothing to extrapolate: fewer than two days of history,
 * or no data at all in the window.
 */
export function linearForecast(
  series: readonly StoragePointDto[],
  horizonDays: number,
): StorageForecastDto | null {
  const last = series.at(-1);
  if (!last || series.length < 2 || series.every((point) => point.bytes === 0)) {
    return null;
  }
  const slope = leastSquaresSlope(series.map((point) => point.bytes));
  const lastDay = Date.parse(`${last.date}T00:00:00.000Z`);
  const points = Array.from({ length: horizonDays }, (_, index) => {
    const step = index + 1;
    return {
      date: utcDayKey(new Date(lastDay + step * DAY_MS)),
      bytes: Math.max(0, Math.round(last.bytes + slope * step)),
    };
  });
  return {
    method: "linear",
    basisDays: series.length,
    slopeBytesPerDay: Math.round(slope),
    points,
  };
}
