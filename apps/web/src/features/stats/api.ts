import { apiFetch } from "@/lib/api";

import type { Granularity, ResolvedPeriod, StatsScope } from "./period.js";

/**
 * Typed client of `/api/v1/stats` (apps/api/src/features/stats): the figures
 * of one period with the previous period for comparison, the CSV export per
 * dataset and the PDF report.
 *
 * A dataset the server has no source for arrives as `{ unavailable: reason }`,
 * never as zeros. The decoder keeps that distinction: every dataset is either
 * `ok` with its rows or `unavailable` with the reason, and a dataset the
 * server did not send at all counts as unavailable too (reason `missing`).
 */

export const KPI_NAMES = [
  "backupSuccessRate",
  "protectedObjects",
  "logicalBytes",
  "physicalBytes",
  "dedupRatio",
  "restores",
  "verifiedShare",
  "throttlingWaitSeconds",
  "failedItems",
] as const;
export type KpiName = (typeof KPI_NAMES)[number];

export const SERIES_NAMES = [
  "backups",
  "volume",
  "storage",
  "jobDurations",
  "throttling",
  "restores",
  "readiness",
] as const;
export type SeriesName = (typeof SERIES_NAMES)[number];

export const TABLE_NAMES = ["failuresByCause", "largestObjects", "tenants"] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** Everything the CSV export can deliver (`dataset=<name>`): the key figures, series and tables. */
export type StatsDataset = "kpis" | SeriesName | TableName;
export const STATS_DATASETS: readonly StatsDataset[] = ["kpis", ...SERIES_NAMES, ...TABLE_NAMES];

/**
 * Why the server has no data source for a dataset (`{ unavailable: reason }`):
 * no tenants yet, nothing protected, no backup yet, or no Microsoft 365
 * source (throttling). The page words each; an unknown reason is shown as sent.
 */
export const UNAVAILABLE_REASONS = [
  "no_tenants",
  "no_protected_objects",
  "no_backups_yet",
  "no_microsoft_365_source",
] as const;

/** Reason used when the server's answer lacks a dataset entirely. */
export const MISSING_REASON = "missing";

export type Dataset<T> = { status: "ok"; rows: T[] } | { status: "unavailable"; reason: string };

export type Kpi =
  | { status: "ok"; value: number | null; previous: number | null }
  | { status: "unavailable"; reason: string };

export interface BackupPoint {
  t: string;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface VolumePoint {
  t: string;
  logicalBytes: number;
  physicalBytes: number;
}

export interface StoragePoint {
  t: string;
  bytes: number;
}

export interface JobDurationRow {
  kind: string;
  p50Seconds: number;
  p95Seconds: number;
  count: number;
}

export interface ThrottlingPoint {
  t: string;
  waitSeconds: number;
  events: number;
}

export interface RestorePoint {
  t: string;
  completed: number;
  failed: number;
}

export interface ReadinessPoint {
  t: string;
  green: number;
  yellow: number;
  red: number;
  unverified: number;
}

export interface FailureCauseRow {
  cause: string;
  count: number;
  lastAt: string | null;
}

export interface LargestObjectRow {
  id: string;
  name: string;
  kind: string;
  logicalBytes: number;
  lastBackupAt: string | null;
  /** Recovery readiness of the object: green, yellow, red, unverified or no_backup. */
  state: string | null;
  /** The tenant the object belongs to; provider scope only. */
  tenant: { id: string; name: string } | null;
}

export interface TenantRow {
  id: string;
  name: string;
  objects: number;
  /** Share of successful backup runs, 0..1; null without runs. */
  successRate: number | null;
  logicalBytes: number;
  physicalBytes: number;
  /** green, yellow or red; null when the tenant protects nothing. */
  readiness: string | null;
  failures: number;
}

export interface PeriodBounds {
  from: string;
  to: string;
  granularity: Granularity | null;
}

export interface StatsOverview {
  period: PeriodBounds | null;
  previous: PeriodBounds | null;
  scope: StatsScope;
  kpis: Record<KpiName, Kpi>;
  series: {
    backups: Dataset<BackupPoint>;
    volume: Dataset<VolumePoint>;
    storage: Dataset<StoragePoint>;
    jobDurations: Dataset<JobDurationRow>;
    throttling: Dataset<ThrottlingPoint>;
    restores: Dataset<RestorePoint>;
    readiness: Dataset<ReadinessPoint>;
  };
  tables: {
    failuresByCause: Dataset<FailureCauseRow>;
    largestObjects: Dataset<LargestObjectRow>;
    /** Provider scope only; `null` in the tenant scope. */
    tenants: Dataset<TenantRow> | null;
  };
}

/** The request of one view: its period, bucket size and scope. */
export interface StatsParams {
  /** First calendar day, `YYYY-MM-DD`, included. */
  from: string;
  /** Last calendar day, `YYYY-MM-DD`, included. */
  to: string;
  granularity: Granularity;
  scope: StatsScope;
}

export function statsParams(period: ResolvedPeriod, scope: StatsScope): StatsParams {
  return { from: period.firstDay, to: period.lastDay, granularity: period.granularity, scope };
}

/**
 * The query string of every stats request, in a fixed order. The scope is
 * only written for the provider scope (the tenant scope is the default and
 * follows the tenant header); `lang` picks the PDF's language.
 */
export function statsQueryString(
  params: StatsParams,
  extra: { dataset?: StatsDataset; lang?: string } = {},
): string {
  const search = new URLSearchParams();
  if (extra.dataset) {
    search.set("dataset", extra.dataset);
  }
  search.set("from", params.from);
  search.set("to", params.to);
  search.set("granularity", params.granularity);
  if (params.scope === "provider") {
    search.set("scope", "provider");
  }
  if (extra.lang) {
    search.set("lang", extra.lang);
  }
  return `?${search.toString()}`;
}

export function statsPath(params: StatsParams): string {
  return `/stats${statsQueryString(params)}`;
}

export function statsCsvPath(dataset: StatsDataset, params: StatsParams): string {
  return `/stats/export.csv${statsQueryString(params, { dataset })}`;
}

/** The PDF report; the language follows the UI (de or en). */
export function statsPdfPath(params: StatsParams, language: string): string {
  const lang = language.toLowerCase().startsWith("de") ? "de" : "en";
  return `/stats/report.pdf${statsQueryString(params, { lang })}`;
}

export async function fetchStats(params: StatsParams): Promise<StatsOverview> {
  return normalizeStats(await apiFetch<unknown>(statsPath(params)), params.scope);
}

/**
 * Query keys. `scopeKey` separates what differs per requester (the provider
 * totals, or one tenant); the period parameters are part of every key, so a
 * new period never shows the numbers of the old one.
 */
export const statsKeys = {
  all: ["stats"] as const,
  overview: (scopeKey: string, params: StatsParams) =>
    [
      "stats",
      scopeKey,
      "overview",
      { from: params.from, to: params.to, granularity: params.granularity, scope: params.scope },
    ] as const,
};

// --- Decoding -----------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const NUMERIC = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/**
 * A number from JSON. Postgres sums and bigints often travel as strings
 * ("1073741824"); those are read as the number they spell. Anything else is
 * no number (null).
 */
function nullableNum(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && NUMERIC.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A count or size inside a row; a missing one counts as nothing happened (0). */
function num(value: unknown): number {
  return nullableNum(value) ?? 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The reason of an `{ unavailable }` marker, or null when `value` is none. */
function unavailableReason(value: unknown): string | null {
  const marker = record(value);
  if (!marker || !("unavailable" in marker)) {
    return null;
  }
  return str(marker.unavailable) ?? MISSING_REASON;
}

/** One dataset: rows decoded one by one, rows without their key fields dropped. */
function dataset<T>(value: unknown, row: (raw: Record<string, unknown>) => T | null): Dataset<T> {
  const reason = unavailableReason(value);
  if (reason !== null) {
    return { status: "unavailable", reason };
  }
  if (!Array.isArray(value)) {
    return { status: "unavailable", reason: MISSING_REASON };
  }
  const rows: T[] = [];
  for (const item of value) {
    const raw = record(item);
    const decoded = raw ? row(raw) : null;
    if (decoded !== null) {
      rows.push(decoded);
    }
  }
  return { status: "ok", rows };
}

function kpi(value: unknown): Kpi {
  const reason = unavailableReason(value);
  if (reason !== null) {
    return { status: "unavailable", reason };
  }
  const raw = record(value);
  if (!raw) {
    return { status: "unavailable", reason: MISSING_REASON };
  }
  return { status: "ok", value: nullableNum(raw.value), previous: nullableNum(raw.previous) };
}

function bounds(value: unknown): PeriodBounds | null {
  const raw = record(value);
  const from = str(raw?.from);
  const to = str(raw?.to);
  if (!raw || !from || !to) {
    return null;
  }
  const granularity =
    raw.granularity === "day" || raw.granularity === "week" || raw.granularity === "month"
      ? raw.granularity
      : null;
  return { from, to, granularity };
}

function timed<T>(build: (raw: Record<string, unknown>, t: string) => T) {
  return (raw: Record<string, unknown>): T | null => {
    const t = str(raw.t);
    return t ? build(raw, t) : null;
  };
}

const ROWS = {
  backups: timed<BackupPoint>((raw, t) => ({
    t,
    succeeded: num(raw.succeeded),
    failed: num(raw.failed),
    cancelled: num(raw.cancelled),
  })),
  volume: timed<VolumePoint>((raw, t) => ({
    t,
    logicalBytes: num(raw.logicalBytes),
    physicalBytes: num(raw.physicalBytes),
  })),
  storage: timed<StoragePoint>((raw, t) => ({ t, bytes: num(raw.bytes) })),
  jobDurations: (raw: Record<string, unknown>): JobDurationRow | null => {
    const kind = str(raw.kind);
    return kind
      ? {
          kind,
          p50Seconds: num(raw.p50Seconds),
          p95Seconds: num(raw.p95Seconds),
          count: num(raw.count),
        }
      : null;
  },
  throttling: timed<ThrottlingPoint>((raw, t) => ({
    t,
    waitSeconds: num(raw.waitSeconds),
    events: num(raw.events),
  })),
  restores: timed<RestorePoint>((raw, t) => ({
    t,
    completed: num(raw.completed),
    failed: num(raw.failed),
  })),
  readiness: timed<ReadinessPoint>((raw, t) => ({
    t,
    green: num(raw.green),
    yellow: num(raw.yellow),
    red: num(raw.red),
    unverified: num(raw.unverified),
  })),
  failuresByCause: (raw: Record<string, unknown>): FailureCauseRow | null => {
    const cause = str(raw.cause);
    return cause ? { cause, count: num(raw.count), lastAt: str(raw.lastAt) } : null;
  },
  largestObjects: (raw: Record<string, unknown>): LargestObjectRow | null => {
    const id = str(raw.id);
    if (!id) {
      return null;
    }
    const tenant = record(raw.tenant);
    const tenantId = str(tenant?.id);
    return {
      id,
      name: str(raw.name) ?? id,
      kind: str(raw.kind) ?? "unknown",
      logicalBytes: num(raw.logicalBytes),
      lastBackupAt: str(raw.lastBackupAt),
      state: str(raw.state),
      tenant: tenantId ? { id: tenantId, name: str(tenant?.name) ?? tenantId } : null,
    };
  },
  tenants: (raw: Record<string, unknown>): TenantRow | null => {
    const id = str(raw.id);
    if (!id) {
      return null;
    }
    return {
      id,
      name: str(raw.name) ?? id,
      objects: num(raw.objects),
      successRate: nullableNum(raw.successRate),
      logicalBytes: num(raw.logicalBytes),
      physicalBytes: num(raw.physicalBytes),
      readiness: str(raw.readiness),
      failures: num(raw.failures),
    };
  },
};

/**
 * Decode `GET /stats` defensively: malformed rows are dropped and a missing
 * dataset becomes `unavailable`, so a partial answer never renders as zeros.
 * `requested` is the scope asked for; the server's own statement wins.
 */
export function normalizeStats(payload: unknown, requested: StatsScope): StatsOverview {
  const raw = record(payload) ?? {};
  const kpis = record(raw.kpis) ?? {};
  const series = record(raw.series) ?? {};
  const tables = record(raw.tables) ?? {};
  const scope: StatsScope =
    raw.scope === "provider" || raw.scope === "tenant" ? raw.scope : requested;

  return {
    period: bounds(raw.period),
    previous: bounds(raw.previous),
    scope,
    kpis: Object.fromEntries(KPI_NAMES.map((name) => [name, kpi(kpis[name])])) as Record<
      KpiName,
      Kpi
    >,
    series: {
      backups: dataset(series.backups, ROWS.backups),
      volume: dataset(series.volume, ROWS.volume),
      storage: dataset(series.storage, ROWS.storage),
      jobDurations: dataset(series.jobDurations, ROWS.jobDurations),
      throttling: dataset(series.throttling, ROWS.throttling),
      restores: dataset(series.restores, ROWS.restores),
      readiness: dataset(series.readiness, ROWS.readiness),
    },
    tables: {
      failuresByCause: dataset(tables.failuresByCause, ROWS.failuresByCause),
      largestObjects: dataset(tables.largestObjects, ROWS.largestObjects),
      tenants:
        scope === "provider" || tables.tenants !== undefined
          ? dataset(tables.tenants, ROWS.tenants)
          : null,
    },
  };
}
