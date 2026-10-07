/**
 * URL state of the statistics pages: the period (a preset or a custom range of
 * calendar days). Keeping it in the URL makes every view linkable and lets it
 * survive a reload. Unknown or invalid values are dropped, never sent to the API.
 *
 * The scope is not URL state: it is the page. Overview › Statistics always
 * shows the active tenant; the statistics of all tenants have a page of their
 * own ({@link ALL_TENANTS_STATS_PATH}). Before 0.3.0 the scope was a parameter
 * of the Overview tab (`scope=provider`), which kept showing every tenant
 * after a switch into one tenant; such links lead to the page of all tenants
 * ({@link legacyProviderScope}).
 *
 * A period is a range of calendar days, both ends included, as the API
 * takes it (`from=2026-09-01&to=2026-09-30`). The days are the ones the
 * viewer picked or sees as "today"; the server counts them as whole days.
 */

/**
 * Statistics is the second tab of Overview (`/?view=statistics`); `/stats`,
 * its address before the final menu, leads there with its query
 * (features/redirects).
 */
export const STATS_PATH = "/";
export const STATS_VIEW = "statistics";

/**
 * The statistics of all tenants (provider admins whose team role covers every
 * tenant, where the installation enables `stats.allTenants`), linked from the
 * Installation section of the menu.
 */
export const ALL_TENANTS_STATS_PATH = "/statistics/all";

export const PERIOD_PRESETS = ["7d", "30d", "90d", "12m"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export type PeriodChoice = PeriodPreset | "custom";

/** The period shown when the URL names none. */
export const DEFAULT_PRESET: PeriodPreset = "30d";

export const GRANULARITIES = ["day", "week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/**
 * Tenant: the active tenant (Overview › Statistics). Provider: every tenant
 * (the page {@link ALL_TENANTS_STATS_PATH}, gated feature `stats.allTenants`).
 */
export type StatsScope = "tenant" | "provider";

export interface StatsSearch {
  /** Omitted for the default preset, so the plain page URL stays canonical. */
  period?: PeriodChoice;
  /** First calendar day (`YYYY-MM-DD`); custom periods only. */
  from?: string;
  /** Last calendar day, inclusive; custom periods only. */
  to?: string;
}

/** Each preset's bucket size: about 7 to 31 points per chart. */
const PRESET_GRANULARITY: Readonly<Record<PeriodPreset, Granularity>> = {
  "7d": "day",
  "30d": "day",
  "90d": "week",
  "12m": "month",
};

/** Length in days of the day-based presets (12 m counts whole months). */
const PRESET_DAYS: Readonly<Record<Exclude<PeriodPreset, "12m">, number>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** A real calendar day in `YYYY-MM-DD` form, else undefined. */
export function calendarDay(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = DAY.exec(value);
  if (!match) {
    return undefined;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  const valid =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return valid ? value : undefined;
}

/** A local date as `YYYY-MM-DD`. */
export function toDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local midnight starting `day`, moved by `offsetDays` whole days. */
export function dayStart(day: string, offsetDays = 0): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, date + offsetDays);
}

/** Calendar days from `first` to `last`, both included (independent of DST). */
export function daysBetween(first: string, last: string): number {
  const utc = (day: string) => {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, date);
  };
  return Math.round((utc(last) - utc(first)) / MS_PER_DAY) + 1;
}

/** Validate raw search params (the route's `validateSearch`). */
export function parseStatsSearch(raw: Record<string, unknown>): StatsSearch {
  const search: StatsSearch = {};
  const period = oneOf(raw.period, [...PERIOD_PRESETS, "custom"] as const);
  if (period === "custom") {
    let from = calendarDay(raw.from);
    let to = calendarDay(raw.to);
    // A custom period needs both ends; half a range falls back to the default.
    if (from && to) {
      if (from > to) {
        [from, to] = [to, from];
      }
      search.period = "custom";
      search.from = from;
      search.to = to;
    }
  } else if (period && period !== DEFAULT_PRESET) {
    search.period = period;
  }
  return search;
}

/**
 * Whether a search asks for the statistics of all tenants the old way
 * (`scope=provider` on Overview › Statistics or on `/stats`): such a link
 * leads to {@link ALL_TENANTS_STATS_PATH} with its period.
 */
export function legacyProviderScope(raw: Readonly<Record<string, unknown>>): boolean {
  return raw.scope === "provider";
}

/** Apply a change; `undefined` removes a key. Presets drop the custom days. */
export function nextStatsSearch(current: StatsSearch, change: Partial<StatsSearch>): StatsSearch {
  const merged: Record<string, unknown> = { ...current, ...change };
  if (merged.period !== "custom") {
    merged.from = undefined;
    merged.to = undefined;
  }
  return parseStatsSearch(merged);
}

/** The search for a preset. */
export function withPreset(current: StatsSearch, preset: PeriodPreset): StatsSearch {
  return nextStatsSearch(current, { period: preset });
}

/** The search for a custom range of local days. */
export function withCustomRange(current: StatsSearch, first: Date, last: Date): StatsSearch {
  return nextStatsSearch(current, { period: "custom", from: toDay(first), to: toDay(last) });
}

/** The longest period the API answers for (two years, a leap day included). */
export const MAX_PERIOD_DAYS = 731;

/** Bucket size for a custom range: days up to a month, weeks up to half a year. */
export function granularityForDays(days: number): Granularity {
  if (days <= 31) {
    return "day";
  }
  return days <= 183 ? "week" : "month";
}

export interface ResolvedPeriod {
  choice: PeriodChoice;
  /** First local day, `YYYY-MM-DD`. */
  firstDay: string;
  /** Last local day, inclusive. */
  lastDay: string;
  /** Number of calendar days, both ends included. */
  days: number;
  granularity: Granularity;
}

function resolved(
  choice: PeriodChoice,
  firstDay: string,
  lastDay: string,
  granularity: Granularity,
): ResolvedPeriod {
  return {
    choice,
    firstDay,
    lastDay,
    days: daysBetween(firstDay, lastDay),
    granularity,
  };
}

/**
 * The concrete period for the URL state. Presets end today: 7, 30 and 90
 * days back, or the current month and the eleven before it (whole months for
 * the monthly buckets). A custom period never reaches past today and covers
 * at most {@link MAX_PERIOD_DAYS} days (the most recent ones). The result
 * only changes when the day changes, so query keys stay stable within a day.
 */
export function resolvePeriod(search: StatsSearch, now: Date = new Date()): ResolvedPeriod {
  const today = toDay(now);
  if (search.period === "custom" && search.from && search.to) {
    const lastDay = search.to > today ? today : search.to;
    const earliest = toDay(dayStart(lastDay, 1 - MAX_PERIOD_DAYS));
    const from = search.from < earliest ? earliest : search.from;
    const firstDay = from > lastDay ? lastDay : from;
    return resolved(
      "custom",
      firstDay,
      lastDay,
      granularityForDays(daysBetween(firstDay, lastDay)),
    );
  }
  const preset: PeriodPreset =
    search.period && search.period !== "custom" ? search.period : DEFAULT_PRESET;
  if (preset === "12m") {
    const firstDay = toDay(new Date(now.getFullYear(), now.getMonth() - 11, 1));
    return resolved(preset, firstDay, today, PRESET_GRANULARITY[preset]);
  }
  const firstDay = toDay(dayStart(today, 1 - PRESET_DAYS[preset]));
  return resolved(preset, firstDay, today, PRESET_GRANULARITY[preset]);
}

/**
 * The comparison period the deltas refer to: the same number of days right
 * before the period (what the API compares against).
 */
export function previousPeriodDays(period: ResolvedPeriod): { firstDay: string; lastDay: string } {
  const lastDay = toDay(dayStart(period.firstDay, -1));
  const firstDay = toDay(dayStart(period.firstDay, -period.days));
  return { firstDay, lastDay };
}
