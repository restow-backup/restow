import type { UsagePoint } from "./types";

/** The usage chart shows the last 30 or 90 days (the API sends 90). */
export const USAGE_RANGES = [30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/** The tail of the daily series for a range. */
export function seriesForRange(series: readonly UsagePoint[], range: UsageRange): UsagePoint[] {
  return series.slice(-range);
}

const FORMATS = {
  short: { day: "numeric", month: "short", timeZone: "UTC" },
  long: { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

/** A series day (`YYYY-MM-DD`, UTC) in the UI language; the raw value when it does not parse. */
export function usageDateLabel(day: string, language: string, style: keyof typeof FORMATS): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return day;
  }
  return new Intl.DateTimeFormat(language, FORMATS[style]).format(date);
}

const STEP_FACTORS = [1, 2, 2.5, 5, 10];

/**
 * Y-axis ticks at round values of a binary unit (0, 50 GB, 100 GB, 150 GB),
 * covering `max` with about `target` intervals. The labels come from
 * `formatBytes`, which also counts in powers of 1024, so they read as round numbers.
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
