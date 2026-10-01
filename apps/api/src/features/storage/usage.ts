/**
 * Storage usage (pure, no I/O): how much the tenant protects, how much that
 * takes in the chunk store, and how the store grew.
 *
 *   logical bytes           the size of the protected data as the sources hold
 *                           it: the latest completed snapshot of every object
 *   retained logical bytes  every retained snapshot added up, i.e. what the
 *                           history would take without deduplication
 *   physical bytes          the sealed packs actually stored (deduplicated and
 *                           encrypted); every target holds this amount
 *
 * Growth comes from the pack rows: a pack is written once and never changes, so
 * its creation date is when its bytes were added. Packs that garbage collection
 * has since replaced no longer exist, so the curve shows how the data that is
 * stored today accumulated (net growth, not gross writes).
 */

export interface DailyBytes {
  /** UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly bytes: number;
}

export interface UsagePoint {
  /** UTC day, `YYYY-MM-DD`. */
  readonly date: string;
  /** Physical bytes stored at the end of that day. */
  readonly bytes: number;
}

export interface GrowthWindow {
  readonly days: number;
  /** Physical bytes added within the window (packs created in it). */
  readonly addedBytes: number;
  /** Growth relative to the stored bytes at the window's start; null when the store was empty then. */
  readonly ratio: number | null;
}

export interface UsageDto {
  readonly logicalBytes: number;
  readonly retainedLogicalBytes: number;
  readonly physicalBytes: number;
  readonly packCount: number;
  readonly snapshotCount: number;
  /** Objects with at least one completed snapshot. */
  readonly protectedObjectCount: number;
  readonly growth: { readonly days30: GrowthWindow; readonly days90: GrowthWindow };
  /** Daily physical bytes over the last {@link SERIES_DAYS} days, oldest first, ending today. */
  readonly series: readonly UsagePoint[];
  readonly generatedAt: string;
}

/** The chart covers 90 days; the 30-day view is the tail of the same series. */
export const SERIES_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day of a date, `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC of the first day of a window of `days` days ending with `today`. */
export function windowStart(today: Date, days: number): Date {
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return new Date(midnight - (days - 1) * DAY_MS);
}

/**
 * The cumulative daily series for the window ending today. `daily` holds the
 * bytes of packs created per day inside the window (days without packs may be
 * absent); everything else in `totalBytes` was stored before the window.
 */
export function buildGrowthSeries(input: {
  readonly totalBytes: number;
  readonly daily: readonly DailyBytes[];
  readonly today: Date;
  readonly days?: number;
}): UsagePoint[] {
  const days = input.days ?? SERIES_DAYS;
  const start = windowStart(input.today, days);
  const first = utcDay(start);
  const last = utcDay(input.today);
  const added = new Map<string, number>();
  for (const entry of input.daily) {
    if (entry.day >= first && entry.day <= last) {
      added.set(entry.day, (added.get(entry.day) ?? 0) + entry.bytes);
    }
  }
  let running = input.totalBytes - [...added.values()].reduce((sum, bytes) => sum + bytes, 0);
  const series: UsagePoint[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = utcDay(new Date(start.getTime() + offset * DAY_MS));
    running += added.get(date) ?? 0;
    series.push({ date, bytes: Math.max(0, running) });
  }
  return series;
}

/** Growth over the last `days` days of a series that ends today. */
export function growthOver(series: readonly UsagePoint[], days: number): GrowthWindow {
  const end = series.at(-1)?.bytes ?? 0;
  const window = series.slice(-days);
  const firstPoint = window[0];
  if (!firstPoint) {
    return { days, addedBytes: 0, ratio: null };
  }
  // The window starts from the end of the day before it. Without such a day in
  // the series, the first day's value is the best available baseline.
  const firstIndex = series.length - window.length;
  const before = firstIndex > 0 ? (series[firstIndex - 1]?.bytes ?? 0) : null;
  const startBytes = before ?? firstPoint.bytes;
  const addedBytes = Math.max(0, end - startBytes);
  return { days, addedBytes, ratio: startBytes > 0 ? addedBytes / startBytes : null };
}

export interface UsageTotals {
  readonly logicalBytes: number;
  readonly retainedLogicalBytes: number;
  readonly physicalBytes: number;
  readonly packCount: number;
  readonly snapshotCount: number;
  readonly protectedObjectCount: number;
}

/** Assemble the usage response from the totals and the per-day pack bytes. */
export function buildUsage(totals: UsageTotals, daily: readonly DailyBytes[], now: Date): UsageDto {
  // One day more than shown, so the 90-day growth has a starting value before the window.
  const extended = buildGrowthSeries({
    totalBytes: totals.physicalBytes,
    daily,
    today: now,
    days: SERIES_DAYS + 1,
  });
  return {
    ...totals,
    growth: { days30: growthOver(extended, 30), days90: growthOver(extended, SERIES_DAYS) },
    series: extended.slice(1),
    generatedAt: now.toISOString(),
  };
}
