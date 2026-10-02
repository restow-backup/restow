/**
 * Time windows of the bandwidth limit as the editors hold them: the draft a row of the list
 * edits, the checks that mirror the API's (packages/core backup-jobs/bandwidth.ts, which is the
 * one place that decides), and the words about a window that the rows show. Pure code, so the
 * rules are tested without a browser.
 *
 * The rules, as the editor says them: a window has days it STARTS on (1 = Monday ... 7 =
 * Sunday), a start that is included and an end that is not, and a limit in kbit/s where 0 means
 * unlimited. An end that is not after the start ends on the next day; the same time twice is a
 * whole day. Windows must not overlap; windows that touch are fine. The times are read in the
 * time zone of the job's schedule, and the limit that applies is the one in force when a run
 * starts.
 */

export interface BandwidthWindow {
  /** Days the window starts on: 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** Local start `HH:MM` (included). */
  from: string;
  /** Local end `HH:MM` (not included); not after `from` means the next day. */
  to: string;
  /** Limit in kbit/s while the window is active; 0 = unlimited. */
  kbps: number;
}

/** The API's limits (apps/api endpoints/schemas.ts, packages/core backup-jobs/bandwidth.ts). */
export const WINDOW_LIMITS = { windows: 24, kbpsMax: 10_000_000 } as const;

/** The days in the order they are shown: Monday first. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** One row of the list as the form holds it; numbers stay text while they are typed. */
export interface WindowDraft {
  /** Stays with the row while it is edited, whatever the rows around it do. */
  key: string;
  days: number[];
  /** `HH:MM`, or empty while the time input is cleared. */
  from: string;
  to: string;
  /** kbit/s, 0 = unlimited. */
  kbps: string;
}

export function windowDraftsOf(windows: readonly BandwidthWindow[] | undefined): WindowDraft[] {
  return (windows ?? []).map((window, index) => ({
    key: `w${index}`,
    days: [...window.days].sort((a, b) => a - b),
    from: window.from,
    to: window.to,
    kbps: String(window.kbps),
  }));
}

/** A new row, started on a working day's office hours so there is something to look at. */
export function newWindowDraft(existing: readonly WindowDraft[] = []): WindowDraft {
  const next =
    existing.reduce((highest, row) => {
      const number = Number(row.key.slice(1));
      return Number.isInteger(number) ? Math.max(highest, number) : highest;
    }, -1) + 1;
  return { key: `w${next}`, days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: "" };
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

function minutesOf(time: string): number | null {
  const match = TIME_OF_DAY.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

/** How long a window lasts in minutes (1 to 1440); the same start and end make a whole day. */
export function windowLength(from: string, to: string): number {
  const length =
    ((minutesOf(to) ?? 0) - (minutesOf(from) ?? 0) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return length === 0 ? MINUTES_PER_DAY : length;
}

/** Whether a window ends on the day after it starts (its end is not after its start). */
export function endsNextDay(from: string, to: string): boolean {
  return (minutesOf(to) ?? 0) <= (minutesOf(from) ?? 0);
}

function segmentsOf(days: readonly number[], from: string, to: string): [number, number][] {
  const length = windowLength(from, to);
  return days.flatMap((day): [number, number][] => {
    const start = (day - 1) * MINUTES_PER_DAY + (minutesOf(from) ?? 0);
    const end = start + length;
    return end <= MINUTES_PER_WEEK
      ? [[start, end]]
      : [
          [start, MINUTES_PER_WEEK],
          [0, end - MINUTES_PER_WEEK],
        ];
  });
}

interface SoundWindow {
  days: number[];
  from: string;
  to: string;
}

/** Whether two windows cover a common minute of the week. */
export function windowsOverlap(a: SoundWindow, b: SoundWindow): boolean {
  const left = segmentsOf(a.days, a.from, a.to);
  const right = segmentsOf(b.days, b.from, b.to);
  return left.some(([aStart, aEnd]) =>
    right.some(([bStart, bEnd]) => aStart < bEnd && bStart < aEnd),
  );
}

// --- Checks -----------------------------------------------------------------------------

export interface WindowProblem {
  /** The message is `backupjobs:problems.form.windows.<code>`. */
  code: string;
  values?: Record<string, string | number>;
}

export type WindowField = "days" | "from" | "to" | "kbps" | "window";
export type WindowRowProblems = Partial<Record<WindowField, WindowProblem>>;

export interface WindowListCheck {
  /** One entry per row, in the order of the rows; `{}` for a row without problems. */
  rows: WindowRowProblems[];
  /** The problem of the list as a whole (too many rows). */
  list?: WindowProblem;
  /** Whether anything at all is wrong. */
  invalid: boolean;
}

/**
 * Everything the API would refuse about the rows, found before the request: a row's own fields,
 * and which rows overlap (said on the later row, naming the other by its number).
 */
export function checkWindowDrafts(drafts: readonly WindowDraft[]): WindowListCheck {
  const rows: WindowRowProblems[] = drafts.map((row) => {
    const problems: WindowRowProblems = {};
    if (row.days.length === 0) {
      problems.days = { code: "days" };
    }
    if (minutesOf(row.from) === null) {
      problems.from = { code: "time" };
    }
    if (minutesOf(row.to) === null) {
      problems.to = { code: "time" };
    }
    const kbps = wholeNumber(row.kbps);
    if (row.kbps.trim() === "") {
      problems.kbps = { code: "kbpsRequired" };
    } else if (kbps === null || kbps > WINDOW_LIMITS.kbpsMax) {
      problems.kbps = { code: "kbps", values: { max: WINDOW_LIMITS.kbpsMax } };
    }
    return problems;
  });
  for (let later = 1; later < drafts.length; later++) {
    const b = drafts[later];
    if (!b || Object.keys(rows[later] ?? {}).some((field) => field !== "kbps")) continue;
    for (let earlier = 0; earlier < later; earlier++) {
      const a = drafts[earlier];
      if (!a || Object.keys(rows[earlier] ?? {}).some((field) => field !== "kbps")) continue;
      if (windowsOverlap(a, b)) {
        (rows[later] as WindowRowProblems).window = {
          code: "overlap",
          values: { other: earlier + 1 },
        };
        break;
      }
    }
  }
  const list: WindowProblem | undefined =
    drafts.length > WINDOW_LIMITS.windows
      ? { code: "tooMany", values: { max: WINDOW_LIMITS.windows } }
      : undefined;
  const invalid = list !== undefined || rows.some((row) => Object.keys(row).length > 0);
  return { rows, ...(list ? { list } : {}), invalid };
}

/** The windows the rows describe, in the order of the week, as the API takes them. Call `checkWindowDrafts` first. */
export function windowsOfDrafts(drafts: readonly WindowDraft[]): BandwidthWindow[] {
  const windows = drafts.map(
    (row): BandwidthWindow => ({
      days: [...new Set(row.days)].sort((a, b) => a - b),
      from: row.from,
      to: row.to,
      kbps: wholeNumber(row.kbps) ?? 0,
    }),
  );
  const order = (window: BandwidthWindow) =>
    (window.days[0] ?? 8) * MINUTES_PER_DAY + (minutesOf(window.from) ?? 0);
  return windows.sort((a, b) => order(a) - order(b) || a.kbps - b.kbps);
}

/** A stable text for a list of windows, to tell two apart (the order of the week, days once). */
export function windowsKey(windows: readonly BandwidthWindow[] | undefined): string {
  return JSON.stringify(
    windowsOfDrafts(windowDraftsOf(windows)).map((window) => [
      window.days,
      window.from,
      window.to,
      window.kbps,
    ]),
  );
}

// --- Words ----------------------------------------------------------------------------------

/** The name of a weekday (1 = Monday ... 7 = Sunday) in a language, `short` or `long`. */
export function weekdayName(
  day: number,
  language: string,
  style: "short" | "long" = "short",
): string {
  // 2026-10-05 is a Monday; the zone is fixed so the name never depends on where the browser is.
  const date = new Date(Date.UTC(2026, 9, 4 + day));
  return new Intl.DateTimeFormat(language, { weekday: style, timeZone: "UTC" }).format(date);
}

/**
 * The days of a window as short text: runs of three or more consecutive days as a range
 * ("Mon-Fri"), the rest listed ("Sat, Sun").
 */
export function daysText(days: readonly number[], language: string): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; ) {
    let end = index;
    while (end + 1 < sorted.length && (sorted[end + 1] as number) === (sorted[end] as number) + 1) {
      end++;
    }
    const first = sorted[index] as number;
    const last = sorted[end] as number;
    if (end - index >= 2) {
      parts.push(`${weekdayName(first, language)}–${weekdayName(last, language)}`);
    } else {
      for (let day = first; day <= last; day++) {
        parts.push(weekdayName(day, language));
      }
    }
    index = end + 1;
  }
  return parts.join(", ");
}
