import type { CapacityGrowth, CapacityTenant } from "./api.js";

/**
 * What the capacity page decides in the browser (pure): which growth is the headline of a row, how
 * the rows are ordered and filtered, which of the empty states a "full on" cell is in, and how a
 * span of days reads. The server does the arithmetic; nothing here computes a forecast.
 */

/** A repository that runs full within this many days counts as near full (the server's `NEAR_FULL_DAYS`). */
export const NEAR_FULL_DAYS = 90;

export type CapacitySortKey = "full" | "growth" | "stored" | "name";
export type SortDirection = "asc" | "desc";
export interface CapacitySort {
  key: CapacitySortKey;
  direction: SortDirection;
}

/** Full soonest first, as the page opens. */
export const DEFAULT_SORT: CapacitySort = { key: "full", direction: "asc" };

/** The direction a column starts in when it is chosen: the soonest, the fastest, the largest first. */
export const FIRST_DIRECTION: Readonly<Record<CapacitySortKey, SortDirection>> = {
  full: "asc",
  growth: "desc",
  stored: "desc",
  name: "asc",
};

export type CapacityFilter = "all" | "attention";
export const CAPACITY_FILTERS: readonly CapacityFilter[] = ["all", "attention"];

export function isCapacityFilter(value: string): value is CapacityFilter {
  return (CAPACITY_FILTERS as readonly string[]).includes(value);
}

export interface GrowthHeadline {
  bytesPerDay: number;
  /** The days it was measured over. */
  days: 7 | 30 | 90;
}

/** The growth a row leads with: the 30-day figure, else the 7-day one, else the 90-day one. */
export function growthHeadline(growth: CapacityGrowth): GrowthHeadline | null {
  if (growth.days30 !== null) {
    return { bytesPerDay: growth.days30, days: 30 };
  }
  if (growth.days7 !== null) {
    return { bytesPerDay: growth.days7, days: 7 };
  }
  if (growth.days90 !== null) {
    return { bytesPerDay: growth.days90, days: 90 };
  }
  return null;
}

/** Days until a tenant's repository runs full at the estimate (the nearer of the band and the line); null where no day is given. */
export function daysUntilFull(tenant: CapacityTenant): number | null {
  return tenant.state === "ok" ? (tenant.full?.nearestInDays ?? null) : null;
}

/** A tenant needs a look: its quota is near or used up, or its repository runs full within {@link NEAR_FULL_DAYS} days. */
export function needsAttention(tenant: CapacityTenant): boolean {
  if (tenant.state !== "ok") {
    return false;
  }
  const days = daysUntilFull(tenant);
  return tenant.quotaLevel !== "ok" || (days !== null && days <= NEAR_FULL_DAYS);
}

export function matchesFilter(tenant: CapacityTenant, filter: CapacityFilter): boolean {
  return filter === "all" || needsAttention(tenant);
}

function sortValue(tenant: CapacityTenant, key: CapacitySortKey): number | null {
  switch (key) {
    case "full":
      return daysUntilFull(tenant);
    case "growth":
      return tenant.state === "ok" ? (growthHeadline(tenant.growth)?.bytesPerDay ?? null) : null;
    case "stored":
      return tenant.usedBytes;
    default:
      return null;
  }
}

/**
 * The rows in the chosen order. A row without a value for the column (no date, no growth yet,
 * figures not available) comes last in either direction; ties go by name.
 */
export function sortTenants(
  tenants: readonly CapacityTenant[],
  sort: CapacitySort,
): CapacityTenant[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  const byName = (a: CapacityTenant, b: CapacityTenant) =>
    a.name.localeCompare(b.name) || a.tenantId.localeCompare(b.tenantId);
  return [...tenants].sort((a, b) => {
    if (sort.key === "name") {
      return sign * byName(a, b);
    }
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    if (left === null || right === null) {
      return left === right ? byName(a, b) : left === null ? 1 : -1;
    }
    return sign * (left - right) || byName(a, b);
  });
}

/** `aria-sort` of a column header. */
export function ariaSortOf(
  sort: CapacitySort,
  key: CapacitySortKey,
): "ascending" | "descending" | "none" {
  if (sort.key !== key) {
    return "none";
  }
  return sort.direction === "asc" ? "ascending" : "descending";
}

/** The sort after the header of `key` was pressed: the column's first direction, then the other way. */
export function nextSort(sort: CapacitySort, key: CapacitySortKey): CapacitySort {
  if (sort.key !== key) {
    return { key, direction: FIRST_DIRECTION[key] };
  }
  return { key, direction: sort.direction === "asc" ? "desc" : "asc" };
}

/** What the "full" cell of a row says: a day, or the reason there is none. Never a fact: always an estimate. */
export type FullView =
  | { kind: "unavailable" }
  | { kind: "s3" }
  | { kind: "shared_default" }
  | { kind: "unknown_limit" }
  | { kind: "no_history" }
  | { kind: "other_data" }
  | { kind: "no_date" }
  | {
      kind: "date";
      /** Days to the nearer day, for "in about N days". */
      inDays: number;
      /** The nearer day. */
      date: string;
      /** The band: the fastest and the slowest growth's days, when both exist. */
      between: { earliest: string; latest: string } | null;
      /** Only the fastest growth's day: at the slowest growth it is not full within ten years. */
      from: string | null;
    };

export function fullView(tenant: CapacityTenant): FullView {
  if (tenant.state !== "ok") {
    return { kind: "unavailable" };
  }
  switch (tenant.limit.kind) {
    case "s3":
      return { kind: "s3" };
    case "shared_default":
      return { kind: "shared_default" };
    case "unknown":
      return { kind: "unknown_limit" };
    default:
      break;
  }
  if (tenant.forecast === null) {
    return { kind: "no_history" };
  }
  if (tenant.limit.dateWithheld === "other_data") {
    return { kind: "other_data" };
  }
  const full = tenant.full;
  if (!full || full.nearest === null || full.nearestInDays === null) {
    return { kind: "no_date" };
  }
  return {
    kind: "date",
    inDays: full.nearestInDays,
    date: full.nearest,
    between: full.earliest && full.latest ? { earliest: full.earliest, latest: full.latest } : null,
    from: full.earliest && !full.latest && tenant.forecast.band ? full.earliest : null,
  };
}

/** A span of days as the page says it: days up to four months, months up to two years, then years. */
export function spanOf(days: number): { unit: "days" | "months" | "years"; count: number } {
  const whole = Math.max(1, Math.round(days));
  if (whole < 120) {
    return { unit: "days", count: whole };
  }
  if (whole < 730) {
    return { unit: "months", count: Math.round(whole / 30.4) };
  }
  return { unit: "years", count: Math.round(whole / 365) };
}

/** Whether a row's date is near enough to warn: the page warns, it never reassures (no green). */
export function isNearFull(inDays: number): boolean {
  return inDays <= NEAR_FULL_DAYS;
}
