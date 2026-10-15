/**
 * Pure helpers for the dashboard's day series: UTC day keys, gap filling and
 * the least-squares slope (the storage chart is growth.ts). The queries return only the
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
 * Least-squares slope of `values` over their positions `xs` (units per unit of
 * x; the index when `xs` is omitted). 0 for fewer than two values or when every
 * value sits at the same position.
 */
export function leastSquaresSlope(values: readonly number[], xs?: readonly number[]): number {
  const n = values.length;
  if (n < 2) {
    return 0;
  }
  const x = (index: number) => xs?.[index] ?? index;
  const meanX = values.reduce((sum, _, index) => sum + x(index), 0) / n;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (x(index) - meanX) * (value - meanY);
    denominator += (x(index) - meanX) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
}
