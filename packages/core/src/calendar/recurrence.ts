/**
 * The occurrences of a backed-up calendar series, computed from its master's recurrence (Graph
 * `patternedRecurrence`) and the exceptions stored with it (backup/exchange/calendar.ts
 * `StoredEvent`). The backup keeps the series master and its modified occurrences, never every
 * occurrence (docs/MICROSOFT.md), so the restore explorer derives them here, the same way
 * Exchange does when a restore recreates the series.
 *
 * Times: Graph returns event times in UTC (the backup asks for that). An occurrence keeps the
 * master's wall-clock time in the series' own time zone, so across a change to or from daylight
 * saving time its UTC time moves by an hour; the zone is the recurrence's `recurrenceTimeZone`,
 * else the event's `originalStartTimeZone`, as an IANA name or one of the common Windows names
 * Exchange uses. An unknown zone falls back to UTC. All-day events are dates and need no zone.
 *
 * Limits: an occurrence deleted from a series on its own is not in the backup (Graph v1.0 lists
 * no cancelled occurrences), so it still appears here, exactly as a restore of the series would
 * recreate it.
 */

/** The parts of a Graph event the expansion reads (structurally `@microsoft/microsoft-graph-types` Event). */
export interface RecurringEventLike {
  id?: string | null;
  subject?: string | null;
  type?: string | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  start?: { dateTime?: string | null; timeZone?: string | null } | null;
  end?: { dateTime?: string | null; timeZone?: string | null } | null;
  originalStart?: string | null;
  originalStartTimeZone?: string | null;
  location?: { displayName?: string | null } | null;
  organizer?: { emailAddress?: { address?: string | null; name?: string | null } | null } | null;
  recurrence?: {
    pattern?: {
      type?: string | null;
      interval?: number | null;
      month?: number | null;
      dayOfMonth?: number | null;
      daysOfWeek?: readonly (string | null)[] | null;
      firstDayOfWeek?: string | null;
      index?: string | null;
    } | null;
    range?: {
      type?: string | null;
      startDate?: string | null;
      endDate?: string | null;
      numberOfOccurrences?: number | null;
      recurrenceTimeZone?: string | null;
    } | null;
  } | null;
}

export interface SeriesOccurrence {
  /** ISO 8601 UTC start. */
  start: string;
  /** ISO 8601 UTC end. */
  end: string;
  isAllDay: boolean;
  /** `occurrence`: as the pattern says; `exception`: changed on its own, as stored. */
  kind: "occurrence" | "exception";
  subject: string | null;
  location: string | null;
  isCancelled: boolean;
  /** For an exception: the start the pattern gave it (ISO 8601 UTC). */
  originalStart: string | null;
}

export interface SeriesExpansion {
  occurrences: SeriesOccurrence[];
  /** More occurrences fall into the window than `limit` allowed. */
  truncated: boolean;
  /** The zone the wall-clock times were kept in ("UTC" when none was known). */
  timeZone: string;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const INDEXES: Readonly<Record<string, number>> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  last: -1,
};
/** A pattern is never walked further than this many steps (a daily series over 100 years). */
const MAX_STEPS = 40_000;

/**
 * Windows time zone names Exchange reports (`originalStartTimeZone`, `recurrenceTimeZone`), for
 * the zones the tenants of an installation commonly work in. Anything else that is a valid IANA
 * name is used as it is.
 */
const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  UTC: "UTC",
  "Coordinated Universal Time": "UTC",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Turkey Standard Time": "Europe/Istanbul",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Singapore Standard Time": "Asia/Singapore",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
};

/** An IANA zone for a Graph zone name; null when none is known. */
export function ianaZoneOf(name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }
  const mapped = WINDOWS_ZONES[name];
  if (mapped) {
    return mapped;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

/** Graph's `2026-10-21T09:00:00.0000000` (UTC by the backup's request), as epoch milliseconds. */
export function graphUtcMillis(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const zoned = /(?:Z|[+-]\d\d:\d\d)$/.test(trimmed) ? trimmed : `${trimmed}Z`;
  const millis = Date.parse(zoned);
  return Number.isNaN(millis) ? null : millis;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallTimeIn(millis: number, zone: string): WallTime {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(millis)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The UTC instant of a wall-clock time in a zone (the earlier one in a repeated hour). */
function utcOfWallTime(wall: WallTime, zone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  if (zone === "UTC") {
    return naive;
  }
  let guess = naive;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const seen = wallTimeIn(guess, zone);
    const seenNaive = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      seen.second,
    );
    const drift = seenNaive - naive;
    if (drift === 0) {
      break;
    }
    guess -= drift;
  }
  return guess;
}

/** A calendar date as days since the epoch (UTC), and back. */
function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function dateOfDay(days: number): { year: number; month: number; day: number; weekday: number } {
  const date = new Date(days * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function parseDate(value: string | null | undefined): number | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return match ? dayNumber(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdaysOf(names: readonly (string | null)[] | null | undefined): number[] {
  return [
    ...new Set(
      (names ?? [])
        .map((name) => WEEKDAYS.indexOf((name ?? "").toLowerCase() as (typeof WEEKDAYS)[number]))
        .filter((index) => index >= 0),
    ),
  ].sort((a, b) => a - b);
}

/** The `index`-th (first … fourth, last) day of a month whose weekday is one of `weekdays`. */
function relativeDay(
  year: number,
  month: number,
  weekdays: number[],
  index: number,
): number | null {
  const first = dayNumber(year, month, 1);
  const length = daysInMonth(year, month);
  const matching: number[] = [];
  for (let offset = 0; offset < length; offset += 1) {
    if (weekdays.includes(dateOfDay(first + offset).weekday)) {
      matching.push(first + offset);
    }
  }
  const picked = index < 0 ? matching[matching.length - 1] : matching[index];
  return picked ?? null;
}

/**
 * The dates (days since the epoch) the pattern produces from `startDay` on, in order, until
 * `lastDay`, at most `count` of them (counted from the series start, as Exchange counts).
 */
function* patternDays(
  pattern: NonNullable<NonNullable<RecurringEventLike["recurrence"]>["pattern"]>,
  startDay: number,
  lastDay: number,
): Generator<number> {
  const interval = Math.max(1, Math.floor(pattern.interval ?? 1));
  const start = dateOfDay(startDay);
  const type = pattern.type ?? "";
  let steps = 0;
  if (type === "daily") {
    for (let day = startDay; day <= lastDay && steps < MAX_STEPS; day += interval, steps += 1) {
      yield day;
    }
    return;
  }
  if (type === "weekly") {
    const weekdays = weekdaysOf(pattern.daysOfWeek);
    const days = weekdays.length > 0 ? weekdays : [start.weekday];
    const firstWeekday = Math.max(
      0,
      WEEKDAYS.indexOf((pattern.firstDayOfWeek ?? "sunday") as never),
    );
    const order = days.map((weekday) => (weekday - firstWeekday + 7) % 7).sort((a, b) => a - b);
    const weekStart = startDay - ((start.weekday - firstWeekday + 7) % 7);
    for (let week = weekStart; week <= lastDay && steps < MAX_STEPS; week += 7 * interval) {
      for (const offset of order) {
        const day = week + offset;
        if (day >= startDay && day <= lastDay) {
          yield day;
        }
      }
      steps += 1;
    }
    return;
  }
  const monthly = type === "absoluteMonthly" || type === "relativeMonthly";
  const yearly = type === "absoluteYearly" || type === "relativeYearly";
  if (!monthly && !yearly) {
    return;
  }
  const stepMonths = monthly ? interval : interval * 12;
  const index = INDEXES[(pattern.index ?? "first").toLowerCase()] ?? 0;
  const weekdays = weekdaysOf(pattern.daysOfWeek);
  let year = start.year;
  let month = yearly && pattern.month ? pattern.month : start.month;
  if (yearly && pattern.month && pattern.month < start.month) {
    year += 1;
  }
  for (; steps < MAX_STEPS; steps += 1) {
    if (dayNumber(year, month, 1) > lastDay) {
      return;
    }
    let day: number | null;
    if (type === "absoluteMonthly" || type === "absoluteYearly") {
      const wanted = pattern.dayOfMonth ?? start.day;
      day = dayNumber(year, month, Math.min(Math.max(1, wanted), daysInMonth(year, month)));
    } else {
      day = relativeDay(year, month, weekdays.length > 0 ? weekdays : [start.weekday], index);
    }
    if (day !== null && day >= startDay && day <= lastDay) {
      yield day;
    }
    month += stepMonths;
    while (month > 12) {
      month -= 12;
      year += 1;
    }
  }
}

/**
 * The occurrences of a series master inside `[from, to)` (epoch milliseconds), the stored
 * exceptions in place of the occurrences they changed, oldest first. A single event (not a
 * master) is its own one occurrence when it falls into the window.
 */
export function expandSeries(
  master: RecurringEventLike,
  exceptions: readonly RecurringEventLike[],
  window: { from: number; to: number },
  limit = 1000,
): SeriesExpansion {
  const startMillis = graphUtcMillis(master.start?.dateTime);
  const endMillis = graphUtcMillis(master.end?.dateTime) ?? startMillis;
  const isAllDay = master.isAllDay === true;
  const subject = master.subject ?? null;
  const location = master.location?.displayName || null;
  const range = master.recurrence?.range;
  const pattern = master.recurrence?.pattern;
  const zone =
    (isAllDay
      ? "UTC"
      : (ianaZoneOf(range?.recurrenceTimeZone) ?? ianaZoneOf(master.originalStartTimeZone))) ??
    "UTC";
  const result: SeriesOccurrence[] = [];
  let truncated = false;
  const push = (occurrence: SeriesOccurrence): boolean => {
    const start = Date.parse(occurrence.start);
    const end = Date.parse(occurrence.end);
    if (start >= window.to || Math.max(end, start + 1) <= window.from) {
      return true;
    }
    if (result.length >= limit) {
      truncated = true;
      return false;
    }
    result.push(occurrence);
    return true;
  };

  if (startMillis === null || endMillis === null) {
    return { occurrences: [], truncated: false, timeZone: zone };
  }
  const duration = Math.max(0, endMillis - startMillis);
  if (master.type !== "seriesMaster" || !pattern) {
    push({
      start: new Date(startMillis).toISOString(),
      end: new Date(endMillis).toISOString(),
      isAllDay,
      kind: "occurrence",
      subject,
      location,
      isCancelled: master.isCancelled === true,
      originalStart: null,
    });
    return { occurrences: result, truncated, timeZone: zone };
  }

  const wall = wallTimeIn(startMillis, zone);
  const firstDay = parseDate(range?.startDate) ?? dayNumber(wall.year, wall.month, wall.day);
  const rangeEnd = range?.type === "endDate" ? parseDate(range.endDate) : null;
  const windowLastDay = Math.floor((window.to + DAY_MS) / DAY_MS);
  const lastDay = rangeEnd === null ? windowLastDay : Math.min(rangeEnd, windowLastDay);
  const count =
    range?.type === "numbered" && range.numberOfOccurrences
      ? Math.max(0, range.numberOfOccurrences)
      : Number.POSITIVE_INFINITY;

  const replaced = new Map<number, RecurringEventLike>();
  for (const exception of exceptions) {
    const original = graphUtcMillis(exception.originalStart ?? null);
    if (original !== null) {
      replaced.set(original, exception);
    }
  }
  const occurrenceOf = (exception: RecurringEventLike, original: number): SeriesOccurrence => {
    const start = graphUtcMillis(exception.start?.dateTime) ?? original;
    const end = graphUtcMillis(exception.end?.dateTime) ?? start + duration;
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      isAllDay: exception.isAllDay ?? isAllDay,
      kind: "exception",
      subject: exception.subject ?? subject,
      location: exception.location?.displayName || location,
      isCancelled: exception.isCancelled === true,
      originalStart: new Date(original).toISOString(),
    };
  };

  let produced = 0;
  const used = new Set<number>();
  for (const day of patternDays(pattern, firstDay, lastDay)) {
    if (produced >= count) {
      break;
    }
    produced += 1;
    const date = dateOfDay(day);
    const start = utcOfWallTime(
      { ...wall, year: date.year, month: date.month, day: date.day },
      zone,
    );
    if (start >= window.to) {
      break;
    }
    const exception = replaced.get(start);
    if (exception) {
      used.add(start);
    }
    const keep = exception
      ? push(occurrenceOf(exception, start))
      : push({
          start: new Date(start).toISOString(),
          end: new Date(start + duration).toISOString(),
          isAllDay,
          kind: "occurrence",
          subject,
          location,
          isCancelled: false,
          originalStart: null,
        });
    if (!keep) {
      break;
    }
  }
  // An exception whose original start the pattern did not produce (a zone the expansion does not
  // know, a pattern changed later) still shows, where it is stored.
  for (const [original, exception] of replaced) {
    if (!used.has(original) && !truncated) {
      push(occurrenceOf(exception, original));
    }
  }
  result.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { occurrences: result, truncated, timeZone: zone };
}
