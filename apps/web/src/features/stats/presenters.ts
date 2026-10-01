import { dedupSavings, formatPercent, parseTimestamp } from "@/lib/format";

import type { Kpi, KpiName, StatsOverview } from "./api.js";
import { type Granularity, dayStart, toDay } from "./period.js";

/**
 * Pure presentation logic of the statistics page: number and date
 * formatting, axis ticks, deltas, empty detection and status tones. The
 * components stay declarative; the decisions live here and are unit tested.
 */

// --- Numbers ------------------------------------------------------------------

/**
 * A share (0..1) as a percentage with one decimal, e.g. "99.4 %". A share
 * below 1 never reads as "100 %" (2499 of 2500 is "99.9 %"), see
 * {@link formatPercent}.
 */
export function formatShare(ratio: number, language: string): string {
  return formatPercent(ratio, language, 1);
}

/** A plain number with at most one decimal (percentage points, ratios). */
export function formatDecimal(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(
    Number.isFinite(value) ? value : 0,
  );
}

const DURATION_UNITS = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
] as const;

/**
 * A duration in its two largest units, e.g. "1 hr 20 min" or "1 Std. 20 Min."
 * (Intl unit names, so the language needs no extra strings).
 */
export function formatDuration(totalSeconds: number, language: string): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  const unitFormat = (unit: string, value: number) =>
    new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "short" }).format(value);
  if (safe === 0) {
    return unitFormat("second", 0);
  }
  // The largest unit that is not zero, then only the next smaller one:
  // "1 hr 20 min", never "1 day 20 s".
  const largest = DURATION_UNITS.findIndex(([, size]) => safe >= size);
  const [unit, size] = DURATION_UNITS[largest] ?? DURATION_UNITS[3];
  const parts = [unitFormat(unit, Math.floor(safe / size))];
  const next = DURATION_UNITS[largest + 1];
  if (next) {
    const amount = Math.floor((safe % size) / next[1]);
    if (amount > 0) {
      parts.push(unitFormat(next[0], amount));
    }
  }
  return parts.join(" ");
}

// --- Axis ticks ---------------------------------------------------------------

const STEP_FACTORS = [1, 2, 2.5, 5, 10];

/**
 * Y-axis ticks at round values of a binary unit (0, 50 GB, 100 GB, ...),
 * covering `max` with about `target` intervals; labels come from
 * `formatBytes`, which counts in powers of 1024 as well.
 */
export function byteTicks(max: number, target = 4): number[] {
  if (!(max > 0)) {
    return [0];
  }
  const unit = 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024)));
  const raw = max / unit / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const factor = STEP_FACTORS.find((candidate) => candidate * magnitude >= raw) ?? 10;
  const step = Math.max(1, factor * magnitude * unit);
  const count = Math.ceil(max / step);
  return Array.from({ length: count + 1 }, (_, index) => index * step);
}

/**
 * Y-axis ticks for counts at round whole steps (0, 100, 200, ... or 0, 1, 2)
 * covering `max` with about `target` intervals.
 */
export function countTicks(max: number, target = 4): number[] {
  if (!(max > 0)) {
    return [0];
  }
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(
    1,
    STEP_FACTORS.map((factor) => factor * magnitude).find(
      (candidate) => candidate >= raw && Number.isInteger(candidate),
    ) ?? 10 * magnitude,
  );
  const count = Math.ceil(max / step);
  return Array.from({ length: count + 1 }, (_, index) => index * step);
}

/** Round duration steps in seconds, from 1 s to 1 week. */
const DURATION_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200, 86_400,
  172_800, 604_800,
];

/** Duration ticks at round steps (30 s, 5 min, 1 h, ...) covering `max` seconds. */
export function durationTicks(max: number, target = 4): number[] {
  if (!(max > 0)) {
    return [0];
  }
  const raw = max / target;
  const step =
    DURATION_STEPS.find((candidate) => candidate >= raw) ?? Math.ceil(raw / 604_800) * 604_800;
  const count = Math.ceil(max / step);
  return Array.from({ length: count + 1 }, (_, index) => index * step);
}

/** The largest value of `keys` over all rows (0 for none). */
export function maxOf<T>(rows: readonly T[], keys: readonly (keyof T)[]): number {
  let max = 0;
  for (const row of rows) {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === "number" && Number.isFinite(value) && value > max) {
        max = value;
      }
    }
  }
  return max;
}

/** The largest stacked total of `keys` over all rows. */
export function maxStacked<T>(rows: readonly T[], keys: readonly (keyof T)[]): number {
  let max = 0;
  for (const row of rows) {
    let total = 0;
    for (const key of keys) {
      const value = row[key];
      total += typeof value === "number" && Number.isFinite(value) ? value : 0;
    }
    max = Math.max(max, total);
  }
  return max;
}

/** Sum of `key` over all rows. */
export function sumOf<T>(rows: readonly T[], key: keyof T): number {
  let total = 0;
  for (const row of rows) {
    const value = row[key];
    total += typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  return total;
}

/**
 * Nothing to plot: no rows, or every value of `keys` is zero. A flat line of
 * zeros tells less than a sentence saying nothing happened.
 */
export function isEmptySeries<T>(rows: readonly T[], keys: readonly (keyof T)[]): boolean {
  return maxOf(rows, keys) === 0;
}

// --- Dates --------------------------------------------------------------------

/** The instant of a bucket (`t`), or null when it does not parse. */
export function bucketDate(t: string): Date | null {
  return parseTimestamp(t);
}

const AXIS_FORMAT: Readonly<Record<Granularity, Intl.DateTimeFormatOptions>> = {
  day: { day: "numeric", month: "short" },
  week: { day: "numeric", month: "short" },
  month: { month: "short", year: "2-digit" },
};

const LONG_FORMAT: Readonly<Record<Granularity, Intl.DateTimeFormatOptions>> = {
  day: { weekday: "short", day: "numeric", month: "long", year: "numeric" },
  week: { day: "numeric", month: "long", year: "numeric" },
  month: { month: "long", year: "numeric" },
};

/** A bucket on the x axis ("23 Sep", "Sep 26"); the raw value when it does not parse. */
export function axisLabel(t: string, granularity: Granularity, language: string): string {
  const date = bucketDate(t);
  return date ? new Intl.DateTimeFormat(language, AXIS_FORMAT[granularity]).format(date) : t;
}

/**
 * A bucket in full for tooltips ("Tue, 23 September 2026", "September
 * 2026"); for weeks the first day, which the caller frames as "week of".
 */
export function longLabel(t: string, granularity: Granularity, language: string): string {
  const date = bucketDate(t);
  return date ? new Intl.DateTimeFormat(language, LONG_FORMAT[granularity]).format(date) : t;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar days of a period the server reports. A date (`2026-09-23`) is
 * an inclusive day; an instant is the exclusive end of the period, so the
 * last day is the one before it. Null when a bound does not parse.
 */
export function boundsToDays(bounds: {
  from: string;
  to: string;
}): { firstDay: string; lastDay: string } | null {
  const from = parseTimestamp(bounds.from);
  const to = parseTimestamp(bounds.to);
  if (!from || !to) {
    return null;
  }
  const last = DATE_ONLY.test(bounds.to) ? to : new Date(to.getTime() - 1);
  if (last.getTime() < from.getTime()) {
    return null;
  }
  return { firstDay: toDay(from), lastDay: toDay(last) };
}

/** Two calendar days as one range, e.g. "25 Aug – 23 Sep 2026". */
export function formatDayRange(firstDay: string, lastDay: string, language: string): string {
  const format = new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const first = dayStart(firstDay);
  const last = dayStart(lastDay);
  return firstDay === lastDay ? format.format(first) : format.formatRange(first, last);
}

// --- Key figures --------------------------------------------------------------

/** How a key figure is formatted, and whether a rise is good news. */
export type KpiFormat = "share" | "count" | "bytes" | "duration";

export interface KpiSpec {
  name: KpiName;
  format: KpiFormat;
  /** true: a rise is good; false: a rise is bad; null: no judgement. */
  higherIsBetter: boolean | null;
}

/**
 * The tiles in reading order, three per row: protection, operations, volume.
 * The deduplication tile is derived (see `dedupFigures`) and comes last.
 */
export const KPI_SPECS: readonly KpiSpec[] = [
  { name: "backupSuccessRate", format: "share", higherIsBetter: true },
  { name: "failedItems", format: "count", higherIsBetter: false },
  { name: "verifiedShare", format: "share", higherIsBetter: true },
  { name: "protectedObjects", format: "count", higherIsBetter: null },
  { name: "restores", format: "count", higherIsBetter: null },
  { name: "throttlingWaitSeconds", format: "duration", higherIsBetter: false },
  { name: "logicalBytes", format: "bytes", higherIsBetter: null },
  { name: "physicalBytes", format: "bytes", higherIsBetter: null },
];

/**
 * The change against the previous period, in the unit the tile shows:
 * percentage points for shares, the plain difference otherwise. Null when
 * either side is missing, so no delta is invented.
 */
export function kpiChange(kpi: Kpi, format: KpiFormat): number | null {
  if (kpi.status !== "ok" || kpi.value === null || kpi.previous === null) {
    return null;
  }
  const change = kpi.value - kpi.previous;
  return format === "share" ? Math.round(change * 1000) / 10 : change;
}

export interface DedupFigures {
  /** Share of the backed-up data deduplication did not have to store (0..1). */
  savings: number | null;
  previousSavings: number | null;
  /** Backed-up bytes per stored byte, e.g. 2.8 for "2.8 : 1". */
  factor: number | null;
}

/** The share a ratio of backed-up to stored bytes saves; never below zero. */
function savingsOf(factor: number): number {
  return Math.max(0, 1 - 1 / factor);
}

function factorFrom(savings: number | null): number | null {
  return savings !== null && savings < 1 ? 1 / (1 - savings) : null;
}

/**
 * Deduplication savings. The server's `dedupRatio` (every retained backup
 * against the bytes in the store) is the true figure and wins; when it has
 * no value, the savings are derived from the logical and physical volume
 * (latest backups only, so they understate the effect). Null when there is
 * nothing to divide.
 */
export function dedupFigures(kpis: StatsOverview["kpis"]): DedupFigures | null {
  const ratio = kpis.dedupRatio;
  if (ratio.status === "ok" && ratio.value !== null && ratio.value > 0) {
    return {
      savings: savingsOf(ratio.value),
      previousSavings:
        ratio.previous !== null && ratio.previous > 0 ? savingsOf(ratio.previous) : null,
      factor: ratio.value,
    };
  }
  const logical = kpis.logicalBytes;
  const physical = kpis.physicalBytes;
  if (logical.status !== "ok" || physical.status !== "ok") {
    return null;
  }
  const savings =
    logical.value !== null && physical.value !== null && logical.value > 0
      ? dedupSavings(logical.value, physical.value)
      : null;
  if (savings === null) {
    return null;
  }
  const previousSavings =
    logical.previous !== null && physical.previous !== null && logical.previous > 0
      ? dedupSavings(logical.previous, physical.previous)
      : null;
  return { savings, previousSavings, factor: factorFrom(savings) };
}

/**
 * Why the deduplication tile has no source: neither the volumes nor the
 * server's ratio are available (the first reason). Null when a source exists
 * and the period simply holds no data.
 */
export function dedupUnavailableReason(kpis: StatsOverview["kpis"]): string | null {
  const volumesKnown = kpis.logicalBytes.status === "ok" && kpis.physicalBytes.status === "ok";
  if (volumesKnown || kpis.dedupRatio.status === "ok") {
    return null;
  }
  for (const name of ["logicalBytes", "physicalBytes", "dedupRatio"] as const) {
    const kpi = kpis[name];
    if (kpi.status === "unavailable") {
      return kpi.reason;
    }
  }
  return null;
}

// --- Status tones -------------------------------------------------------------

export type Tone = "success" | "warning" | "destructive" | "muted" | "info" | "neutral";

/** Recovery readiness as a status tone (unverified counts as not ready to trust). */
export function readinessTone(readiness: string | null): Tone {
  switch (readiness) {
    case "green":
      return "success";
    case "yellow":
      return "warning";
    case "red":
      return "destructive";
    default:
      return "muted";
  }
}

/** Object states the page can name; anything else is shown as sent. */
export const KNOWN_OBJECT_STATES = [
  "active",
  "excluded",
  "orphaned",
  "failed",
  "green",
  "yellow",
  "red",
  "unverified",
  "no_backup",
] as const;

/**
 * An object's state as a tone. A protected (active) object is neutral: it is in
 * scope and backed up, which no restore check has proven. Only a rating of
 * green, a passed restore check, is a success.
 */
export function objectStateTone(state: string | null): Tone {
  switch (state) {
    case "active":
      return "neutral";
    case "green":
      return "success";
    case "orphaned":
    case "yellow":
      return "warning";
    case "failed":
    case "red":
      return "destructive";
    default:
      return "muted";
  }
}

/**
 * A share (0..1) of backup runs that completed as a tone: all good, some
 * failures, mostly failing. Only a run history without a single failure is in
 * order, and that is neutral rather than green: a run that completed has not
 * been read back by a restore check. One failed run in thousands still shows
 * as a warning.
 */
export function runRateTone(rate: number | null): Tone {
  if (rate === null) {
    return "muted";
  }
  if (rate >= 1) {
    return "neutral";
  }
  return rate >= 0.9 ? "warning" : "destructive";
}
