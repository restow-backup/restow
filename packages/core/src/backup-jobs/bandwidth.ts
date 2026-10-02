// The upload limit of a machine job over the week: a default limit and, on top of it, time
// windows with a limit of their own. Pure code, shared by the API (validation when a job or a
// machine is saved, and the limit the agent is told when it asks for its configuration) and
// tested without I/O.
//
// How a window reads (the rules the editor says in its own words):
//
// - `days` are the days of the week a window STARTS on, numbered like ISO 8601: 1 is Monday, 7 is
//   Sunday. A window that crosses midnight ends on the next day: "Monday to Friday, 22:00 to
//   06:00" runs from Monday 22:00 to Tuesday 06:00, ... , Friday 22:00 to Saturday 06:00.
// - `from` is included, `to` is not: 08:00 to 18:00 limits at 17:59 and no longer at 18:00. A
//   `to` that is not after `from` ends on the next day; `to` equal to `from` makes the window
//   last 24 hours, so "all day" is 00:00 to 00:00.
// - The times are wall-clock times in one IANA time zone (the schedule's zone of the machine's
//   job). A clock change moves the real instants, not the wall times: on the night the clocks
//   go forward a window that spans the gap lasts an hour less, on the night they go back an
//   hour more, and a window that lies entirely inside the skipped hour does not apply that day.
// - `kbps` is kilobits per second; 0 means unlimited.
// - Windows never overlap: a list in which two windows cover the same minute of the week is
//   refused, so there is no precedence to remember. Windows that touch (one ends when the next
//   starts) are fine. `activeBandwidthWindow` still answers for an overlapping list somebody
//   wrote past the check (the first window in the stored order wins).

import { isValidTimeZone, localParts } from "../schedule/cron.js";
import { DEFAULT_SCHEDULE_TIMEZONE } from "../schedule/defaults.js";

/** One time window of the week with the upload limit that applies in it. */
export interface BandwidthWindow {
  /** Days the window starts on: 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** Local start time `HH:MM` (included). */
  from: string;
  /** Local end time `HH:MM` (not included); not after `from` means the next day. */
  to: string;
  /** Limit in kbit/s while the window is active; 0 = unlimited. */
  kbps: number;
}

/** The most windows a job (or one machine's own setting) may carry. */
export const MAX_BANDWIDTH_WINDOWS = 24;
/** The highest limit, default and windows alike (10 Tbit/s is a sentinel for "far above any link"). */
export const MAX_BANDWIDTH_KBPS = 10_000_000;
/** The days of the week in the order they are shown (ISO 8601: Monday first). */
export const BANDWIDTH_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since midnight of `HH:MM`; null for anything else. */
export function minutesOfDay(time: unknown): number | null {
  if (typeof time !== "string") {
    return null;
  }
  const match = TIME_OF_DAY.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** How long a window lasts, in minutes: 1 to 1440 (equal start and end: a whole day). */
export function bandwidthWindowMinutes(window: Pick<BandwidthWindow, "from" | "to">): number {
  const from = minutesOfDay(window.from) ?? 0;
  const to = minutesOfDay(window.to) ?? 0;
  const length = (to - from + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return length === 0 ? MINUTES_PER_DAY : length;
}

/** Whether a window ends on the day after it starts (end not after start). */
export function bandwidthWindowEndsNextDay(window: Pick<BandwidthWindow, "from" | "to">): boolean {
  const from = minutesOfDay(window.from) ?? 0;
  const to = minutesOfDay(window.to) ?? 0;
  return to <= from;
}

export type BandwidthWindowIssueCode =
  | "too_many"
  | "days_required"
  | "days_invalid"
  | "time_invalid"
  | "kbps_invalid"
  | "overlap";

export interface BandwidthWindowIssue {
  /** The window the problem is in; null for the list as a whole. */
  readonly index: number | null;
  /** The field of that window; `window` for a problem between windows (overlap). */
  readonly field: "days" | "from" | "to" | "kbps" | "window";
  readonly code: BandwidthWindowIssueCode;
  /** Overlap: the other window of the pair. */
  readonly other?: number;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** The segments `[start, end)` of the week (in minutes from Monday 00:00) a window covers on one day. */
function segmentsOf(startDay: number, window: BandwidthWindow): [number, number][] {
  const start = (startDay - 1) * MINUTES_PER_DAY + (minutesOfDay(window.from) ?? 0);
  const end = start + bandwidthWindowMinutes(window);
  return end <= MINUTES_PER_WEEK
    ? [[start, end]]
    : [
        [start, MINUTES_PER_WEEK],
        [0, end - MINUTES_PER_WEEK],
      ];
}

function weekSegments(window: BandwidthWindow): [number, number][] {
  return window.days.flatMap((day) => segmentsOf(day, window));
}

/** Whether two windows cover a common minute of the week. */
export function bandwidthWindowsOverlap(a: BandwidthWindow, b: BandwidthWindow): boolean {
  const left = weekSegments(a);
  const right = weekSegments(b);
  return left.some(([aStart, aEnd]) =>
    right.some(([bStart, bEnd]) => aStart < bEnd && bStart < aEnd),
  );
}

/**
 * Everything wrong with a list of windows, in the order of the list: the shape of each window,
 * then which windows overlap (reported once, on the later window of the pair, with the other
 * one named). An empty list is fine.
 */
export function bandwidthWindowIssues(
  windows: readonly BandwidthWindow[],
): readonly BandwidthWindowIssue[] {
  const issues: BandwidthWindowIssue[] = [];
  if (windows.length > MAX_BANDWIDTH_WINDOWS) {
    issues.push({ index: null, field: "window", code: "too_many" });
  }
  const sound: boolean[] = [];
  for (const [index, window] of windows.entries()) {
    let ok = true;
    if (!Array.isArray(window.days) || window.days.length === 0) {
      issues.push({ index, field: "days", code: "days_required" });
      ok = false;
    } else if (
      window.days.some((day) => !isInteger(day) || day < 1 || day > 7) ||
      window.days.length > 7
    ) {
      issues.push({ index, field: "days", code: "days_invalid" });
      ok = false;
    }
    if (minutesOfDay(window.from) === null) {
      issues.push({ index, field: "from", code: "time_invalid" });
      ok = false;
    }
    if (minutesOfDay(window.to) === null) {
      issues.push({ index, field: "to", code: "time_invalid" });
      ok = false;
    }
    if (!isInteger(window.kbps) || window.kbps < 0 || window.kbps > MAX_BANDWIDTH_KBPS) {
      issues.push({ index, field: "kbps", code: "kbps_invalid" });
      ok = false;
    }
    sound.push(ok);
  }
  for (let later = 1; later < windows.length; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      const a = windows[earlier];
      const b = windows[later];
      if (a && b && sound[earlier] && sound[later] && bandwidthWindowsOverlap(a, b)) {
        issues.push({ index: later, field: "window", code: "overlap", other: earlier });
        break;
      }
    }
  }
  return issues;
}

/** The first problem of a list of windows, or null: the one a refused request names. */
export function firstBandwidthWindowIssue(
  windows: readonly BandwidthWindow[],
): BandwidthWindowIssue | null {
  return bandwidthWindowIssues(windows)[0] ?? null;
}

/**
 * The windows as they are stored: every window's days once and in order, the windows in the order
 * of the week (first day, then start time). Two lists that mean the same come out the same, so
 * saving a job again without a change writes nothing new to a machine.
 */
export function normalizeBandwidthWindows(windows: readonly BandwidthWindow[]): BandwidthWindow[] {
  const keyOf = (window: BandwidthWindow) =>
    (window.days[0] ?? 8) * MINUTES_PER_DAY + (minutesOfDay(window.from) ?? 0);
  return windows
    .map((window) => ({
      days: [...new Set(window.days)].sort((a, b) => a - b),
      from: window.from,
      to: window.to,
      kbps: window.kbps,
    }))
    .sort((a, b) => keyOf(a) - keyOf(b) || a.kbps - b.kbps);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a calendar date, independent of any time zone. */
function isoWeekday(year: number, month: number, day: number): number {
  const sunday0 = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sunday0 === 0 ? 7 : sunday0;
}

/**
 * The window that is active at `now` on the wall clock of `timeZone`, or null. The caller passes a
 * zone that exists ({@link bandwidthTimeZone}); an unknown one reads as no window.
 */
export function activeBandwidthWindow(
  windows: readonly BandwidthWindow[],
  timeZone: string,
  now: Date,
): BandwidthWindow | null {
  if (windows.length === 0 || !isValidTimeZone(timeZone)) {
    return null;
  }
  const local = localParts(now, timeZone);
  const minuteOfWeek =
    (isoWeekday(local.year, local.month, local.day) - 1) * MINUTES_PER_DAY +
    local.hour * 60 +
    local.minute;
  for (const window of windows) {
    const length = bandwidthWindowMinutes(window);
    const from = minutesOfDay(window.from);
    if (from === null) {
      continue;
    }
    for (const day of window.days) {
      const start = (day - 1) * MINUTES_PER_DAY + from;
      const elapsed = (minuteOfWeek - start + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
      if (elapsed < length) {
        return window;
      }
    }
  }
  return null;
}

/**
 * The upload limit in kbit/s that applies at `now`: the active window's, else the default; null
 * for unlimited (a window of 0 and a default of null alike). This is what the agent is told when
 * it asks for its configuration, so a run keeps the limit that applied when it started.
 */
export function effectiveBandwidthKbps(
  defaultKbps: number | null | undefined,
  windows: readonly BandwidthWindow[] | undefined,
  timeZone: string,
  now: Date,
): number | null {
  const active =
    windows && windows.length > 0 ? activeBandwidthWindow(windows, timeZone, now) : null;
  const kbps = active ? active.kbps : (defaultKbps ?? null);
  return kbps !== null && kbps > 0 ? kbps : null;
}

/**
 * The zone a machine's windows are read in: the zone of its schedule, else the tenant's, else the
 * installation's default (Europe/Berlin). The first one that is an IANA zone this runtime knows.
 */
export function bandwidthTimeZone(...candidates: readonly (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "" && isValidTimeZone(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_SCHEDULE_TIMEZONE;
}
