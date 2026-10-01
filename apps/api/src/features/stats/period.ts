import { ProblemError } from "../../problem.js";

/**
 * The period a statistics request covers, its comparison period and the
 * buckets its series are split into (pure, no I/O).
 *
 * Periods are whole UTC days: `from` and `to` are calendar days and both are
 * included, so "2026-09-01 to 2026-09-30" is the thirty days of September.
 * The previous period has the same length and ends the day before `from`,
 * which is what every "vs. previous period" delta compares against.
 *
 * Buckets follow the granularity: one per day, per ISO week (weeks start on
 * Monday) or per calendar month. A bucket never reaches outside the period,
 * so the first and last bucket of a week or month view may be shorter; each
 * bucket is labelled with its first day inside the period (`t`).
 */

export const GRANULARITIES = ["day", "week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** The longest period one request may cover (two years, a leap day included). */
export const MAX_PERIOD_DAYS = 731;

/** The period used when the request names none: the last 30 days, today included. */
export const DEFAULT_PERIOD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DayRange {
  /** First day, `YYYY-MM-DD` (UTC), included. */
  readonly from: string;
  /** Last day, `YYYY-MM-DD` (UTC), included. */
  readonly to: string;
  /** Midnight UTC at the start of `from`. */
  readonly start: Date;
  /** Midnight UTC after `to`: the exclusive end. */
  readonly end: Date;
  readonly days: number;
}

export interface Bucket {
  /** First day of the bucket inside the period, `YYYY-MM-DD`. */
  readonly t: string;
  readonly start: Date;
  /** Exclusive end, never after the period's end. */
  readonly end: Date;
}

export interface ResolvedPeriod {
  readonly current: DayRange;
  readonly previous: DayRange;
  readonly granularity: Granularity;
  readonly buckets: readonly Bucket[];
}

export interface PeriodInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly granularity?: Granularity | undefined;
}

/** The UTC calendar day of an instant, `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC of a `YYYY-MM-DD` day, or null for anything that is not a real day. */
export function parseDay(value: string): Date | null {
  const match = DAY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // Date.UTC rolls 2026-02-30 over to March; a real day survives the round trip.
  return utcDay(date) === value ? date : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function dayRange(start: Date, days: number): DayRange {
  const end = addDays(start, days);
  return { from: utcDay(start), to: utcDay(addDays(end, -1)), start, end, days };
}

/** The granularity that keeps a chart readable: days up to a month, weeks up to half a year. */
export function autoGranularity(days: number): Granularity {
  if (days <= 31) {
    return "day";
  }
  return days <= 183 ? "week" : "month";
}

/** Start of the day, ISO week (Monday) or month an instant falls in, UTC. */
export function truncate(date: Date, granularity: Granularity): Date {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  switch (granularity) {
    case "day":
      return new Date(midnight);
    case "week": {
      // getUTCDay: Sunday = 0; ISO weeks start on Monday.
      const sinceMonday = (date.getUTCDay() + 6) % 7;
      return new Date(midnight - sinceMonday * DAY_MS);
    }
    case "month":
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
}

function nextBoundary(date: Date, granularity: Granularity): Date {
  const start = truncate(date, granularity);
  switch (granularity) {
    case "day":
      return addDays(start, 1);
    case "week":
      return addDays(start, 7);
    case "month":
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }
}

/** Split a range into buckets of the granularity, clipped to the range. */
export function bucketsOf(
  range: Pick<DayRange, "start" | "end">,
  granularity: Granularity,
): Bucket[] {
  const buckets: Bucket[] = [];
  let cursor = range.start;
  while (cursor.getTime() < range.end.getTime()) {
    const boundary = nextBoundary(cursor, granularity);
    const end = boundary.getTime() < range.end.getTime() ? boundary : range.end;
    buckets.push({ t: utcDay(cursor), start: cursor, end });
    cursor = end;
  }
  return buckets;
}

function invalidPeriod(reason: string, detail: string): ProblemError {
  return new ProblemError(422, "Invalid period", {
    type: "urn:restow:problem:stats-period-invalid",
    detail,
    extensions: { reason },
  });
}

/**
 * Resolve the requested period against `now`: defaults for what is missing,
 * validation of what is given, the comparison period and the buckets.
 * `to` may be at most one day after today (UTC), so a client east of UTC can
 * ask for its own "today" shortly after midnight; later days hold no data yet.
 */
export function resolvePeriod(input: PeriodInput, now: Date): ResolvedPeriod {
  const today = parseDay(utcDay(now)) as Date;
  const toDay = input.to === undefined ? today : parseDay(input.to);
  if (!toDay) {
    throw invalidPeriod("invalid_day", "`to` must be a calendar day in the form YYYY-MM-DD.");
  }
  const fromDay =
    input.from === undefined ? addDays(toDay, -(DEFAULT_PERIOD_DAYS - 1)) : parseDay(input.from);
  if (!fromDay) {
    throw invalidPeriod("invalid_day", "`from` must be a calendar day in the form YYYY-MM-DD.");
  }
  if (fromDay.getTime() > toDay.getTime()) {
    throw invalidPeriod("from_after_to", "`from` must not be later than `to`.");
  }
  if (toDay.getTime() > addDays(today, 1).getTime()) {
    throw invalidPeriod("in_future", "`to` must not lie in the future.");
  }
  const days = Math.round((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1;
  if (days > MAX_PERIOD_DAYS) {
    throw invalidPeriod(
      "too_long",
      `A period may cover at most ${MAX_PERIOD_DAYS} days; this one covers ${days}.`,
    );
  }
  const current = dayRange(fromDay, days);
  const previous = dayRange(addDays(fromDay, -days), days);
  const granularity = input.granularity ?? autoGranularity(days);
  return { current, previous, granularity, buckets: bucketsOf(current, granularity) };
}

/**
 * Index of the bucket each day of the period falls in, keyed by `YYYY-MM-DD`,
 * for folding per-day rows from the database into buckets.
 */
export function bucketIndexByDay(period: ResolvedPeriod): Map<string, number> {
  const index = new Map<string, number>();
  period.buckets.forEach((bucket, position) => {
    for (let day = bucket.start; day.getTime() < bucket.end.getTime(); day = addDays(day, 1)) {
      index.set(utcDay(day), position);
    }
  });
  return index;
}
