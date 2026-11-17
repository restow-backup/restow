import { zonedTimeToUtc } from "@restow/core";

/**
 * Days and months of the billing close (docs/ARCHITECTURE.md, "Monatsabschluss der Abrechnung"),
 * as calendar dates in the installation's time zone. Pure: no I/O, no clock.
 *
 * A day is `YYYY-MM-DD`, a month (period) `YYYY-MM`. A month begins at 00:00 on its 1st in the
 * zone; where a zone skips that minute (a daylight-saving switch at midnight), at the first minute
 * that exists. A day of 23 or 25 hours is still one day.
 */

export const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar day `instant` falls on in `timeZone`, `YYYY-MM-DD`. */
export function localDay(instant: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    dayFormatter(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The month a day belongs to. */
export function periodOfDay(day: string): string {
  return day.slice(0, 7);
}

function parsePeriod(period: string): { year: number; month: number } {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) {
    throw new Error(`not a billing period: ${period}`);
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

function formatPeriod(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** The month after `period`. */
export function nextPeriod(period: string): string {
  const { year, month } = parsePeriod(period);
  return month === 12 ? formatPeriod(year + 1, 1) : formatPeriod(year, month + 1);
}

/** How many days `period` has. */
export function daysInPeriod(period: string): number {
  const { year, month } = parsePeriod(period);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The first and the day after the last day of `period`, for `day >= first AND day < end`. */
export function periodDayRange(period: string): { first: string; end: string } {
  return { first: `${period}-01`, end: `${nextPeriod(period)}-01` };
}

/** The instant `period` begins in `timeZone`: 00:00 on its 1st, or the first minute after. */
export function periodStart(period: string, timeZone: string): Date {
  const { year, month } = parsePeriod(period);
  for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
    const at = zonedTimeToUtc(
      { year, month, day: 1, hour: Math.floor(minutes / 60), minute: minutes % 60 },
      timeZone,
    );
    if (at) {
      return at;
    }
  }
  // No zone skips a whole day at the start of a month; keep a defined answer all the same.
  return new Date(Date.UTC(year, month - 1, 1));
}

/** Where `period` begins and ends (the next month's beginning) in `timeZone`. */
export function periodBounds(period: string, timeZone: string): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: periodStart(period, timeZone),
    endsAt: periodStart(nextPeriod(period), timeZone),
  };
}

/** Whether `period` has ended at `now` in `timeZone`, so it may be closed. */
export function periodHasEnded(period: string, now: Date, timeZone: string): boolean {
  return periodOfDay(localDay(now, timeZone)) > period;
}
