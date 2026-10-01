// Five-field cron expressions evaluated in an IANA time zone, without a
// dependency: `minute hour day-of-month month day-of-week`, each field a `*`,
// a number, a list (`1,15`), a range (`1-5`), or a step (`*/15`, `1-30/5`).
// Day-of-week is 0-7 (0 and 7 are Sunday). As in Vixie cron, when both
// day-of-month and day-of-week are restricted a day matches if either does.
//
// Time-zone maths uses Intl only: local calendar parts are read through
// Intl.DateTimeFormat and converted back with an offset probe, so a schedule
// like "02:30 every day in Europe/Berlin" survives daylight-saving switches
// (a wall time that does not exist on a spring-forward day is skipped).

export interface CronSpec {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** True when the day-of-month field was `*` (unrestricted). */
  readonly anyDayOfMonth: boolean;
  /** True when the day-of-week field was `*` (unrestricted). */
  readonly anyDayOfWeek: boolean;
}

interface FieldRange {
  readonly min: number;
  readonly max: number;
  readonly name: string;
}

const FIELDS: readonly FieldRange[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 7, name: "day-of-week" },
];

/** Upper bound on the search: five years covers every valid expression (29 February included). */
const MAX_SEARCH_DAYS = 366 * 5;
const MINUTE_MS = 60_000;

export class CronSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronSyntaxError";
  }
}

function parseNumber(text: string, field: FieldRange): number {
  if (!/^\d+$/.test(text)) {
    throw new CronSyntaxError(`${field.name}: "${text}" is not a number`);
  }
  const value = Number.parseInt(text, 10);
  if (value < field.min || value > field.max) {
    throw new CronSyntaxError(`${field.name}: ${value} is outside ${field.min}-${field.max}`);
  }
  return value;
}

function parseField(text: string, field: FieldRange): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(",")) {
    const [rangeText, stepText] = part.split("/");
    if (stepText !== undefined && part.split("/").length !== 2) {
      throw new CronSyntaxError(`${field.name}: "${part}" has more than one step`);
    }
    const step = stepText === undefined ? 1 : parseNumber(stepText, { ...field, min: 1, max: 60 });
    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = field.min;
      end = field.max;
      if (step === 1) {
        any = true;
      }
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      start = parseNumber(a, field);
      end = parseNumber(b, field);
      if (start > end) {
        throw new CronSyntaxError(`${field.name}: range "${rangeText}" is reversed`);
      }
    } else {
      start = parseNumber(rangeText, field);
      end = stepText === undefined ? start : field.max;
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return { values, any };
}

/** Parse a five-field cron expression. Throws {@link CronSyntaxError} on invalid input. */
export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronSyntaxError(`expected 5 fields, got ${fields.length}`);
  }
  const [minute, hour, dom, month, dow] = fields.map((text, i) => parseField(text, FIELDS[i]));
  const daysOfWeek = new Set<number>();
  for (const day of dow.values) {
    daysOfWeek.add(day === 7 ? 0 : day);
  }
  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek,
    anyDayOfMonth: dom.any,
    anyDayOfWeek: dow.any,
  };
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of an instant in a time zone. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts: Partial<LocalParts> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(instant)) {
    if (
      type === "year" ||
      type === "month" ||
      type === "day" ||
      type === "hour" ||
      type === "minute"
    ) {
      parts[type] = Number.parseInt(value, 10);
    }
  }
  return parts as LocalParts;
}

function partsAsUtc(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

/**
 * The instant at which a zone shows the given wall-clock time, or null when
 * that wall time does not exist (daylight-saving gap).
 */
export function zonedTimeToUtc(parts: LocalParts, timeZone: string): Date | null {
  const wanted = partsAsUtc(parts);
  // Probe the offset at the naive instant, then correct once for the offset
  // that applies at the corrected instant (handles the hours around a switch).
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const offset = partsAsUtc(localParts(new Date(guess), timeZone)) - guess;
    guess = wanted - offset;
  }
  const check = localParts(new Date(guess), timeZone);
  return partsAsUtc(check) === wanted ? new Date(guess) : null;
}

/** Day of week (0 = Sunday) of a calendar date, independent of time zone. */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) {
    return false;
  }
  const domMatch = spec.daysOfMonth.has(day);
  const dowMatch = spec.daysOfWeek.has(dayOfWeek(year, month, day));
  if (spec.anyDayOfMonth && spec.anyDayOfWeek) {
    return true;
  }
  if (spec.anyDayOfMonth) {
    return dowMatch;
  }
  if (spec.anyDayOfWeek) {
    return domMatch;
  }
  return domMatch || dowMatch;
}

/**
 * The first instant strictly after `after` that matches `spec` in `timeZone`,
 * or null when nothing matches within five years.
 */
export function nextCronOccurrence(spec: CronSpec, after: Date, timeZone: string): Date | null {
  const hours = [...spec.hours].sort((a, b) => a - b);
  const minutes = [...spec.minutes].sort((a, b) => a - b);
  const startInstant = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const start = localParts(new Date(startInstant), timeZone);

  let { year, month, day } = start;
  for (let offset = 0; offset < MAX_SEARCH_DAYS; offset++) {
    if (dayMatches(spec, year, month, day)) {
      const firstDay = offset === 0;
      for (const hour of hours) {
        if (firstDay && hour < start.hour) {
          continue;
        }
        for (const minute of minutes) {
          if (firstDay && hour === start.hour && minute < start.minute) {
            continue;
          }
          const instant = zonedTimeToUtc({ year, month, day, hour, minute }, timeZone);
          if (instant && instant.getTime() >= startInstant) {
            return instant;
          }
        }
      }
    }
    day++;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }
  }
  return null;
}
