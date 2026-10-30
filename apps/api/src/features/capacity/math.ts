import type { StorageForecastDto } from "../dashboard/dto.js";
import {
  type DayTotal,
  growthPerDay,
  historyFromTotals,
  runsFull,
  type StorageSeries,
  storageBuckets,
  storageForecast,
} from "../dashboard/growth.js";
import type { StorageLimit } from "../dashboard/storage-growth.js";
import { parseDay, utcDay } from "../stats/period.js";
import type {
  CapacityBasis,
  CapacityForecastDto,
  CapacityFullDto,
  CapacityGrowthDto,
  CapacityLimitDto,
} from "./dto.js";

/**
 * The arithmetic of the capacity page (pure, no I/O): which history a tenant's growth is read
 * from, the growth per day over 7, 30 and 90 days, the estimate and the day a repository runs
 * full. The estimate itself is the dashboard's (dashboard/growth.ts `storageForecast`,
 * `runsFull`), fed with either the daily size samples or the pack dates.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The growth horizons of the page, in days. */
export const GROWTH_HORIZONS = [7, 30, 90] as const;
/** The history the estimate looks at: the longest growth horizon. */
export const CAPACITY_HISTORY_DAYS = 90;
/** How far ahead the estimate looks (it is never longer than the history). */
export const CAPACITY_FORECAST_DAYS = 90;
/** Fewer days of size samples do not carry an estimate: the pack dates are used until then. */
export const SAMPLE_BASIS_MIN_DAYS = 7;
/** A repository that runs full within this many days counts as "near full". */
export const NEAR_FULL_DAYS = 90;

/** What the tenant's packs say, read in one pass: when the first was written and its bytes at the horizons. */
export interface PackFacts {
  /** When the first pack was written; null for a tenant without packs. */
  firstWriteAt: Date | null;
  /** All pack bytes now. */
  totalBytes: number;
  /** Pack bytes written until the end of the day `GROWTH_HORIZONS[i]` days ago. */
  bytesAtHorizons: readonly number[];
}

/** The days a series of samples spans, first and last day counted; 0 without any. */
export function sampleSpanDays(samples: readonly DayTotal[]): number {
  const first = samples[0] ? parseDay(samples[0].date) : null;
  const last = samples.at(-1) ? parseDay(samples.at(-1)?.date ?? "") : null;
  return first && last ? Math.round((last.getTime() - first.getTime()) / DAY_MS) + 1 : 0;
}

/**
 * The history a tenant's growth is read from: its size samples once they span a week (they count
 * the restic repositories too and are not shrunk by pruning), until then the pack dates, else
 * nothing.
 */
export function chooseBasis(
  samples: readonly DayTotal[],
  packs: Pick<PackFacts, "firstWriteAt">,
): CapacityBasis {
  if (sampleSpanDays(samples) >= SAMPLE_BASIS_MIN_DAYS) {
    return "samples";
  }
  return packs.firstWriteAt ? "packs" : "none";
}

/**
 * The pack bytes at the end of today (as of now) and of the days 7, 30 and 90 days ago, for the
 * horizons the first pack is not younger than.
 */
export function packTotals(now: Date, packs: PackFacts): DayTotal[] {
  const first = packs.firstWriteAt;
  if (!first) {
    return [];
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const totals: DayTotal[] = [];
  GROWTH_HORIZONS.forEach((days, index) => {
    const dayStart = today - days * DAY_MS;
    // The day has to be over for the tenant's first write: a rate over fewer days is no 30-day rate.
    if (first.getTime() < dayStart + DAY_MS) {
      totals.push({ date: utcDay(new Date(dayStart)), bytes: packs.bytesAtHorizons[index] ?? 0 });
    }
  });
  totals.sort((a, b) => a.date.localeCompare(b.date));
  totals.push({ date: utcDay(new Date(today)), bytes: packs.totalBytes });
  return totals;
}

/** Growth per day over 7, 30 and 90 days from the basis' totals; every horizon null for `none`. */
export function growthOf(
  basis: CapacityBasis,
  now: Date,
  samples: readonly DayTotal[],
  packs: PackFacts,
): CapacityGrowthDto {
  if (basis === "none") {
    return { days7: null, days30: null, days90: null };
  }
  const totals = basis === "samples" ? samples : packTotals(now, packs);
  const today = utcDay(now);
  const rate = (days: number) => {
    const value = growthPerDay(totals, today, days);
    return value === null ? null : Math.round(value);
  };
  return { days7: rate(7), days30: rate(30), days90: rate(90) };
}

/** The series the estimate is read from when the basis is the samples. */
export function sampleSeries(now: Date, samples: readonly DayTotal[]): StorageSeries {
  return historyFromTotals(now, CAPACITY_HISTORY_DAYS, samples);
}

/** The estimate of a series, as the dashboard makes it, without the chart's points. */
export function forecastOf(series: StorageSeries): {
  dto: CapacityForecastDto;
  forecast: StorageForecastDto;
  today: string;
} | null {
  const buckets = storageBuckets(series.window, series.baseline, series.written);
  const forecast = storageForecast(series.window, buckets, CAPACITY_FORECAST_DAYS);
  const today = buckets.at(-1)?.date;
  if (!forecast || !today) {
    return null;
  }
  return {
    today,
    forecast,
    dto: {
      basisDays: forecast.basisDays,
      slopeBytesPerDay: forecast.slopeBytesPerDay,
      band: forecast.band
        ? {
            slowestBytesPerDay: forecast.band.slowestBytesPerDay,
            fastestBytesPerDay: forecast.band.fastestBytesPerDay,
          }
        : null,
    },
  };
}

function daysBetween(from: string, to: string): number {
  const start = parseDay(from)?.getTime() ?? 0;
  const end = parseDay(to)?.getTime() ?? 0;
  return Math.round((end - start) / DAY_MS);
}

/** What the page says of the repository's limit, and the day it runs full where that can be said. */
export function limitAndFull(input: {
  limit: StorageLimit;
  basis: CapacityBasis;
  series: StorageSeries | null;
}): {
  limit: CapacityLimitDto;
  full: CapacityFullDto | null;
  forecast: CapacityForecastDto | null;
} {
  const { limit, basis, series } = input;
  const estimate = series ? forecastOf(series) : null;
  const space = limit.kind === "filesystem" ? limit.space : null;
  // A history of the pack dates does not count the restic repositories written to the same place.
  const withheld = space !== null && basis === "packs" && limit.otherData;
  const dto: CapacityLimitDto = {
    kind: limit.kind,
    freeBytes: space?.freeBytes ?? null,
    totalBytes: space?.totalBytes ?? null,
    dateWithheld: withheld ? "other_data" : null,
  };
  if (!space || withheld || !series || !estimate) {
    return { limit: dto, full: null, forecast: estimate?.dto ?? null };
  }
  const days = runsFull(estimate.today, space.freeBytes, estimate.forecast);
  const inDays = (date: string | null) => (date ? daysBetween(estimate.today, date) : null);
  const estimateInDays = inDays(days.estimate);
  const nearest = [days.earliest, days.estimate]
    .filter((date): date is string => date !== null)
    .sort()[0];
  return {
    limit: dto,
    forecast: estimate.dto,
    full: {
      ...days,
      estimateInDays,
      nearest: nearest ?? null,
      nearestInDays: inDays(nearest ?? null),
    },
  };
}
