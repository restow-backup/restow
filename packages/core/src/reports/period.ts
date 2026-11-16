import { isValidTimeZone, localParts, zonedTimeToUtc } from "../schedule/cron.js";
import type { ReportCadence } from "./catalog.js";

/**
 * The period a summary report covers (0.5.0). A rule with a calendar cadence covers the previous
 * calendar day, the previous Monday to Sunday, or the previous calendar month, in the rule's time
 * zone; a rule with its own interval or cron keeps the rolling `periodDays` ending at the run.
 * Calendar arithmetic is done on wall-clock dates and turned into instants at the end, so a
 * daylight saving switch makes a day 23 or 25 hours long instead of moving its edges.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportPeriod {
  /** Inclusive start. */
  readonly start: Date;
  /** Exclusive end. */
  readonly end: Date;
}

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A calendar date `days` later (or earlier), without any time zone. */
function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * The instant a calendar day begins in `timeZone`. Midnight that does not exist (a zone that
 * switches at midnight) is the first hour that does.
 */
export function startOfDayIn(date: CalendarDate, timeZone: string): Date {
  for (let hour = 0; hour < 4; hour++) {
    const instant = zonedTimeToUtc({ ...date, hour, minute: 0 }, timeZone);
    if (instant) {
      return instant;
    }
  }
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

/** The calendar date of an instant in `timeZone`. */
export function calendarDateIn(instant: Date, timeZone: string): CalendarDate {
  const parts = localParts(instant, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** Monday 0 … Sunday 6. */
function isoWeekday(date: CalendarDate): number {
  return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

export type ReportPeriodSpec =
  | { readonly cadence: ReportCadence; readonly periodDays?: number | null }
  | { readonly cadence?: null; readonly periodDays: number };

/**
 * The period a report fired at `now` covers: the last complete calendar day, week (Monday to
 * Sunday) or month before `now` in `timeZone`, or the `periodDays` ending at `now`.
 */
export function reportPeriod(spec: ReportPeriodSpec, now: Date, timeZone: string): ReportPeriod {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  if (!spec.cadence) {
    const days = Math.max(1, Math.floor(spec.periodDays ?? 7));
    return { start: new Date(now.getTime() - days * DAY_MS), end: now };
  }
  const today = calendarDateIn(now, zone);
  if (spec.cadence === "daily") {
    return {
      start: startOfDayIn(addDays(today, -1), zone),
      end: startOfDayIn(today, zone),
    };
  }
  if (spec.cadence === "weekly") {
    const monday = addDays(today, -isoWeekday(today));
    return {
      start: startOfDayIn(addDays(monday, -7), zone),
      end: startOfDayIn(monday, zone),
    };
  }
  const first: CalendarDate = { year: today.year, month: today.month, day: 1 };
  const previous: CalendarDate =
    today.month === 1
      ? { year: today.year - 1, month: 12, day: 1 }
      : { year: today.year, month: today.month - 1, day: 1 };
  return { start: startOfDayIn(previous, zone), end: startOfDayIn(first, zone) };
}

/** The period's length in whole days (rounded), for the payload's `periodDays`. */
export function periodLengthDays(period: ReportPeriod): number {
  return Math.max(1, Math.round((period.end.getTime() - period.start.getTime()) / DAY_MS));
}

/** `YYYY-MM` of the month a monthly period covers (its start in `timeZone`). */
export function periodMonth(period: ReportPeriod, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const date = calendarDateIn(period.start, zone);
  return `${date.year}-${String(date.month).padStart(2, "0")}`;
}

/** The calendar month `YYYY-MM` as a period in `timeZone`; null for anything else. */
export function monthPeriod(month: string, timeZone: string): ReportPeriod | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) {
    return null;
  }
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const next =
    monthNumber === 12
      ? { year: year + 1, month: 1, day: 1 }
      : { year, month: monthNumber + 1, day: 1 };
  return {
    start: startOfDayIn({ year, month: monthNumber, day: 1 }, zone),
    end: startOfDayIn(next, zone),
  };
}
