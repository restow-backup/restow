import {
  autoGranularity,
  type Bucket,
  bucketsOf,
  type Granularity,
  truncate,
  utcDay,
} from "../stats/period.js";
import type {
  StorageBandDto,
  StorageCapacityDto,
  StorageForecastDto,
  StoragePointDto,
} from "./dto.js";
import { leastSquaresSlope } from "./series.js";

/**
 * The storage growth chart of the start page (pure, no I/O): the window a
 * request covers, the stored bytes at the end of each bucket, the estimate
 * and, where the repository's capacity is known, when it runs full.
 *
 * The window is a number of whole UTC days ending with today, but never
 * longer than the tenant's history: a year asked for by a tenant that wrote
 * its first data six weeks ago shows those six weeks. Long windows are
 * summed up per ISO week or calendar month in the database, as the
 * statistics pages do (stats/period.ts), so a year is a dozen rows, never one
 * per pack or per day.
 *
 * An estimate never reaches further ahead than the history it rests on, and
 * from three months of history on it is a band between the slowest and the
 * fastest growth seen in that history rather than one line: a straight line
 * over a year reads more exact than it is.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The shortest window: a chart of fewer days says nothing about growth. */
export const STORAGE_MIN_DAYS = 7;
/** The longest window and horizon: a year, a leap day included. */
export const STORAGE_MAX_DAYS = 366;
/** The window and horizon when the request names none. */
export const STORAGE_DEFAULT_DAYS = 30;
/** From this much history on the estimate is a band, not a line. */
export const BAND_MIN_DAYS = 90;
/** A filesystem that lasts longer than this at the current growth has no date that means anything. */
export const RUNS_FULL_MAX_DAYS = 3650;

export type StorageGranularity = Granularity;

export interface StorageWindow {
  /** The days the request asked for. */
  readonly requestedDays: number;
  /** The days shown: the request, clamped to the history that exists (at least {@link STORAGE_MIN_DAYS}). */
  readonly days: number;
  readonly granularity: StorageGranularity;
  /** Midnight UTC of the first day shown. */
  readonly start: Date;
  /** Midnight UTC after today: the exclusive end. */
  readonly end: Date;
  readonly buckets: readonly Bucket[];
}

function midnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * The window of a request for `requestedDays` days ending today. `firstWrite`
 * is when the tenant's oldest stored data was written (null: nothing yet); the
 * window does not reach before that day, except to keep its minimum length.
 */
export function storageWindow(
  now: Date,
  requestedDays: number,
  firstWrite: Date | null,
): StorageWindow {
  const today = midnight(now);
  const historyDays = firstWrite ? Math.round((today - midnight(firstWrite)) / DAY_MS) + 1 : 0;
  const days = Math.min(requestedDays, Math.max(STORAGE_MIN_DAYS, historyDays));
  const start = new Date(today - (days - 1) * DAY_MS);
  const end = new Date(today + DAY_MS);
  const granularity = autoGranularity(days);
  return {
    requestedDays,
    days,
    granularity,
    start,
    end,
    buckets: bucketsOf({ start, end }, granularity),
  };
}

/**
 * The key the database groups a write under (`date_trunc` of its UTC time,
 * as `YYYY-MM-DD`): the day, the Monday of its ISO week, or the first of its
 * month. The first bucket of a window may start inside its week or month; it
 * still has the key of the whole week or month.
 */
export function bucketKey(start: Date, granularity: StorageGranularity): string {
  return utcDay(truncate(start, granularity));
}

/** One bucket of the series with what the band needs on top of the stored total. */
export interface StorageBucket extends StoragePointDto {
  /** Bytes written during the bucket. */
  written: number;
  /** Whole days the bucket covers inside the window. */
  days: number;
  /** Days from the start of the window to the end of the bucket. */
  offsetDays: number;
  /** The bucket is a whole week or month (the first and the current one may be cut short). */
  complete: boolean;
}

function isComplete(bucket: Bucket, granularity: StorageGranularity): boolean {
  const start = truncate(bucket.start, granularity);
  if (start.getTime() !== bucket.start.getTime()) {
    return false;
  }
  if (granularity === "month") {
    const next = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
    return bucket.end.getTime() === next;
  }
  return (
    bucket.end.getTime() - bucket.start.getTime() === (granularity === "week" ? 7 : 1) * DAY_MS
  );
}

/**
 * Bytes stored at the end of each bucket: what existed before the window plus
 * everything written up to the end of that bucket. A point is dated with the
 * last day of its bucket (today for the current one), the day its total was
 * reached, so the estimate continues from today.
 */
export function storageBuckets(
  window: StorageWindow,
  baseline: number,
  written: readonly { bucket: string; bytes: number }[],
): StorageBucket[] {
  const byKey = new Map<string, number>();
  for (const row of written) {
    byKey.set(row.bucket, (byKey.get(row.bucket) ?? 0) + row.bytes);
  }
  let total = baseline;
  return window.buckets.map((bucket) => {
    const bytes = byKey.get(bucketKey(bucket.start, window.granularity)) ?? 0;
    total += bytes;
    return {
      date: utcDay(new Date(bucket.end.getTime() - DAY_MS)),
      bytes: total,
      written: bytes,
      days: Math.round((bucket.end.getTime() - bucket.start.getTime()) / DAY_MS),
      offsetDays: Math.round((bucket.end.getTime() - window.start.getTime()) / DAY_MS),
      complete: isComplete(bucket, window.granularity),
    };
  });
}

/** Days between two estimate points: a day, a week or (about) a month, like the history. */
const FORECAST_STEP_DAYS: Readonly<Record<StorageGranularity, number>> = {
  day: 1,
  week: 7,
  month: 30,
};

/** Day offsets of the estimate's points after today, the last one exactly at the horizon. */
function forecastOffsets(horizonDays: number, granularity: StorageGranularity): number[] {
  const step = FORECAST_STEP_DAYS[granularity];
  const count = Math.ceil(horizonDays / step);
  return Array.from({ length: count }, (_, index) => Math.min((index + 1) * step, horizonDays));
}

/**
 * The slowest and the fastest growth per day of the history, from its whole
 * weeks or months (the first and the current one are cut short and would
 * read as a slump); with fewer than two whole ones, from every bucket.
 */
export function growthRange(
  buckets: readonly StorageBucket[],
): { slowest: number; fastest: number } | null {
  const whole = buckets.filter((bucket) => bucket.complete);
  const basis = whole.length >= 2 ? whole : buckets;
  if (basis.length < 2) {
    return null;
  }
  const rates = basis.map((bucket) => bucket.written / Math.max(1, bucket.days));
  return { slowest: Math.min(...rates), fastest: Math.max(...rates) };
}

/**
 * The estimate for `horizonDays` days after today: the least-squares slope
 * of the stored totals over time, continued from today's total (so it joins
 * the measured line) and never below zero; from {@link BAND_MIN_DAYS} days of
 * history on, the band between the slowest and the fastest growth as well.
 * The horizon is clamped to the days of history the estimate rests on. Null
 * when there is nothing to extrapolate: fewer than two points, or no data.
 */
export function storageForecast(
  window: StorageWindow,
  buckets: readonly StorageBucket[],
  requestedHorizonDays: number,
): StorageForecastDto | null {
  const last = buckets.at(-1);
  if (!last || buckets.length < 2 || buckets.every((bucket) => bucket.bytes === 0)) {
    return null;
  }
  const horizonDays = Math.min(requestedHorizonDays, window.days);
  const slope = Math.max(
    0,
    leastSquaresSlope(
      buckets.map((bucket) => bucket.bytes),
      buckets.map((bucket) => bucket.offsetDays),
    ),
  );
  const today = Date.parse(`${last.date}T00:00:00.000Z`);
  const offsets = forecastOffsets(horizonDays, window.granularity);
  const dateAt = (offset: number) => utcDay(new Date(today + offset * DAY_MS));
  const points = offsets.map((offset) => ({
    date: dateAt(offset),
    bytes: Math.round(last.bytes + slope * offset),
  }));

  const range = window.days >= BAND_MIN_DAYS ? growthRange(buckets) : null;
  const band: StorageBandDto | null = range
    ? {
        slowestBytesPerDay: Math.round(range.slowest),
        fastestBytesPerDay: Math.round(range.fastest),
        points: offsets.map((offset) => ({
          date: dateAt(offset),
          low: Math.round(last.bytes + range.slowest * offset),
          high: Math.round(last.bytes + range.fastest * offset),
        })),
      }
    : null;

  return {
    method: "linear",
    basisDays: window.days,
    slopeBytesPerDay: Math.round(slope),
    horizonDays,
    points,
    band,
  };
}

/** The day `freeBytes` are used up at `bytesPerDay`, or null when that is not within ten years. */
function fullOn(today: string, freeBytes: number, bytesPerDay: number): string | null {
  if (bytesPerDay <= 0) {
    return null;
  }
  const days = Math.ceil(freeBytes / bytesPerDay);
  if (days > RUNS_FULL_MAX_DAYS) {
    return null;
  }
  return utcDay(new Date(Date.parse(`${today}T00:00:00.000Z`) + days * DAY_MS));
}

/**
 * When the free space of the repository's filesystem is used up at the growth
 * of the estimate: one day for the line, the earliest (fastest growth) and the
 * latest (slowest growth) for the band. Each is null when it lies more than
 * ten years ahead or the growth is zero.
 */
export function runsFull(
  today: string,
  freeBytes: number,
  forecast: StorageForecastDto | null,
): NonNullable<StorageCapacityDto["runsFull"]> {
  if (!forecast) {
    return { estimate: null, earliest: null, latest: null };
  }
  return {
    estimate: fullOn(today, freeBytes, forecast.slopeBytesPerDay),
    earliest: forecast.band ? fullOn(today, freeBytes, forecast.band.fastestBytesPerDay) : null,
    latest: forecast.band ? fullOn(today, freeBytes, forecast.band.slowestBytesPerDay) : null,
  };
}
