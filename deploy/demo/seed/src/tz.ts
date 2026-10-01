/**
 * Wall-clock times in an IANA time zone, without a library: the demo's
 * simulated machines follow the schedule the product gives them (a server
 * backs up daily at 22:00 in the tenant's zone, `Europe/Berlin` by default),
 * so the seed needs "22:00 on that day in Berlin" as a UTC instant, and the
 * next such instant after a given moment.
 */

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock fields of `instant` in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): Parts {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") {
      parts[part.type] = Number.parseInt(part.value, 10);
    }
  }
  return {
    year: parts.year as number,
    month: parts.month as number,
    day: parts.day as number,
    hour: parts.hour as number,
    minute: parts.minute as number,
    second: parts.second as number,
  };
}

/** Milliseconds the zone's wall clock is ahead of UTC at `instant`. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the wall clock of `timeZone` reads
 * `year-month-day hour:minute`. A time that does not exist (the hour skipped
 * when clocks go forward) resolves to the instant after the gap.
 */
export function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = naive - zoneOffsetMs(new Date(naive), timeZone);
  // The offset at the guess may differ from the one at the naive instant
  // (a change of offset in between); one more round settles it.
  guess = naive - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** The first instant after `after` at which the wall clock of `timeZone` reads `timeOfDay` ("HH:MM"). */
export function nextDailyRun(after: Date, timeOfDay: string, timeZone: string): Date {
  const [hourText, minuteText] = timeOfDay.split(":");
  const hour = Number.parseInt(hourText ?? "", 10);
  const minute = Number.parseInt(minuteText ?? "", 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`not a time of day: ${timeOfDay}`);
  }
  const today = zonedParts(after, timeZone);
  for (let offset = 0; offset <= 2; offset++) {
    const noon = Date.UTC(today.year, today.month - 1, today.day + offset, 12, 0, 0);
    const day = new Date(noon);
    const candidate = localToUtc(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }
  throw new Error("no next run found");
}
