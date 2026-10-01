/**
 * Presets: the readable forms of a cadence the schedule form offers ("every 8
 * hours", "daily at 04:30", "weekly on Sunday at 03:00", "monthly on the 1st
 * at 05:00") and their mapping to the stored interval or cron expression.
 *
 * This mirrors packages/core/src/schedule/presets.ts, which the API and the
 * scheduler use; the browser bundle does not depend on @restow/core (it pulls
 * in storage and mail libraries), so the mapping is kept here as well and both
 * copies are held to the same round-trip tests.
 */

/** Day of week, 0 = Sunday … 6 = Saturday (cron numbering; 7 is read as Sunday). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type SchedulePreset =
  | { readonly type: "every_minutes"; readonly minutes: number }
  | { readonly type: "every_hours"; readonly hours: number }
  | { readonly type: "daily"; readonly hour: number; readonly minute: number }
  | {
      readonly type: "weekly";
      readonly days: readonly Weekday[];
      readonly hour: number;
      readonly minute: number;
    }
  | {
      readonly type: "monthly";
      readonly dayOfMonth: number;
      readonly hour: number;
      readonly minute: number;
    }
  | { readonly type: "custom"; readonly cron: string };

export type PresetType = SchedulePreset["type"];

/** The preset types in the order the form lists them. */
export const PRESET_TYPES: readonly PresetType[] = [
  "every_hours",
  "every_minutes",
  "daily",
  "weekly",
  "monthly",
  "custom",
];

/** Monthly presets stop at the 28th, the last day every month has. */
export const MAX_PRESET_DAY_OF_MONTH = 28;

/** The stored form of a cadence: an interval or a cron expression, the other null. */
export interface StoredCadence {
  intervalMinutes: number | null;
  cron: string | null;
}

const SINGLE_NUMBER = /^\d{1,2}$/;

function single(text: string, min: number, max: number): number | null {
  if (!SINGLE_NUMBER.test(text)) {
    return null;
  }
  const value = Number.parseInt(text, 10);
  return value >= min && value <= max ? value : null;
}

/** A day-of-week field made of plain days and ranges (`1-5`, `0,6`), or null. */
function weekdays(text: string): Weekday[] | null {
  const days = new Set<Weekday>();
  for (const part of text.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    const start = range ? single(range[1] ?? "", 0, 7) : single(part, 0, 7);
    const end = range ? single(range[2] ?? "", 0, 7) : start;
    if (start === null || end === null || start > end) {
      return null;
    }
    for (let day = start; day <= end; day++) {
      days.add((day % 7) as Weekday);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * The preset that reads a stored cadence best. Intervals of whole hours are
 * "every N hours", other intervals "every N minutes"; cron expressions with a
 * single minute and hour map to daily, weekly or monthly; everything else is
 * custom.
 */
export function presetFromCadence(cadence: StoredCadence): SchedulePreset {
  if (cadence.intervalMinutes !== null) {
    const minutes = cadence.intervalMinutes;
    return minutes % 60 === 0
      ? { type: "every_hours", hours: minutes / 60 }
      : { type: "every_minutes", minutes };
  }
  const cron = (cadence.cron ?? "").trim();
  const custom: SchedulePreset = { type: "custom", cron };
  const fields = cron.split(/\s+/);
  if (fields.length !== 5) {
    return custom;
  }
  const [minuteText, hourText, domText, monthText, dowText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minute = single(minuteText, 0, 59);
  const hour = single(hourText, 0, 23);
  if (minute === null || hour === null || monthText !== "*") {
    return custom;
  }
  if (domText === "*" && dowText === "*") {
    return { type: "daily", hour, minute };
  }
  if (domText === "*") {
    const days = weekdays(dowText);
    if (days === null) {
      return custom;
    }
    return days.length === 7
      ? { type: "daily", hour, minute }
      : { type: "weekly", days, hour, minute };
  }
  if (dowText === "*") {
    const dayOfMonth = single(domText, 1, MAX_PRESET_DAY_OF_MONTH);
    return dayOfMonth === null ? custom : { type: "monthly", dayOfMonth, hour, minute };
  }
  return custom;
}

/** `[1,2,3,4,5]` → `1-5`, `[0,6]` → `0,6`: runs of three or more days become ranges. */
export function formatWeekdays(days: readonly Weekday[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && (sorted[end + 1] as number) === (sorted[end] as number) + 1) {
      end++;
    }
    if (end - index >= 2) {
      parts.push(`${sorted[index]}-${sorted[end]}`);
    } else {
      for (let i = index; i <= end; i++) {
        parts.push(String(sorted[i]));
      }
    }
    index = end + 1;
  }
  return parts.join(",");
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a whole number between ${min} and ${max}`);
  }
}

function assertTime(hour: number, minute: number): void {
  assertRange("hour", hour, 0, 23);
  assertRange("minute", minute, 0, 59);
}

/**
 * The stored cadence of a preset (interval or cron, the other null). Throws a
 * RangeError for values a preset cannot hold (hour 24, no weekday, the 31st);
 * limits such as the minimum interval are checked by the API.
 */
export function cadenceFromPreset(preset: SchedulePreset): StoredCadence {
  switch (preset.type) {
    case "every_minutes":
      assertRange("minutes", preset.minutes, 1, Number.MAX_SAFE_INTEGER);
      return { intervalMinutes: preset.minutes, cron: null };
    case "every_hours":
      assertRange("hours", preset.hours, 1, Number.MAX_SAFE_INTEGER / 60);
      return { intervalMinutes: preset.hours * 60, cron: null };
    case "daily":
      assertTime(preset.hour, preset.minute);
      return { intervalMinutes: null, cron: `${preset.minute} ${preset.hour} * * *` };
    case "weekly": {
      assertTime(preset.hour, preset.minute);
      if (preset.days.length === 0) {
        throw new RangeError("a weekly preset needs at least one day");
      }
      for (const day of preset.days) {
        assertRange("day", day, 0, 6);
      }
      const dow = new Set(preset.days).size === 7 ? "*" : formatWeekdays(preset.days);
      return { intervalMinutes: null, cron: `${preset.minute} ${preset.hour} * * ${dow}` };
    }
    case "monthly":
      assertTime(preset.hour, preset.minute);
      assertRange("dayOfMonth", preset.dayOfMonth, 1, MAX_PRESET_DAY_OF_MONTH);
      return {
        intervalMinutes: null,
        cron: `${preset.minute} ${preset.hour} ${preset.dayOfMonth} * *`,
      };
    case "custom":
      return { intervalMinutes: null, cron: preset.cron.trim() };
    default:
      return assertNever(preset);
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown preset ${JSON.stringify(value)}`);
}
