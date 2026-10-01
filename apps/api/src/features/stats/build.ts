import { type TenantAggregate, type Totals, mergeTotals } from "./aggregate.js";
import { MAX_CAUSES, sortCauses } from "./causes.js";
import type {
  Dataset,
  JobDurationDto,
  KpiDto,
  StatsDto,
  StatsScopeName,
  TenantRowDto,
  UnavailableReason,
} from "./dto.js";
import type { ResolvedPeriod } from "./period.js";
import { countedTotal, provenCount } from "./readiness.js";

/**
 * The statistics response from bucketed figures (pure). Rates and ratios are
 * derived here from sums, and every dataset without a data source becomes
 * `{ unavailable: reason }` (see dto.ts for the honesty rules).
 */

/** Job queues in the order the durations table lists them. */
const QUEUE_ORDER = [
  "backup",
  "restore",
  "verify",
  "directory",
  "archive",
  "retention",
  "scrub",
  "storage_migration",
] as const;

/** Round to a fixed number of decimals, so ratios read the same in JSON, CSV and PDF. */
export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** `part / whole`, or null when there is nothing to divide by. */
export function ratio(part: number, whole: number, decimals = 4): number | null {
  return whole > 0 ? round(part / whole, decimals) : null;
}

/** Percentile of sorted values with linear interpolation (Postgres' percentile_cont). */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

export function jobDurations(durations: ReadonlyMap<string, readonly number[]>): JobDurationDto[] {
  const known = new Set<string>(QUEUE_ORDER);
  const queues = [
    ...QUEUE_ORDER.filter((queue) => durations.has(queue)),
    ...[...durations.keys()].filter((queue) => !known.has(queue)).sort(),
  ];
  return queues.flatMap((queue) => {
    const sorted = [...(durations.get(queue) ?? [])].sort((a, b) => a - b);
    if (sorted.length === 0) {
      return [];
    }
    return [
      {
        kind: queue,
        p50Seconds: round(percentile(sorted, 0.5), 1),
        p95Seconds: round(percentile(sorted, 0.95), 1),
        count: sorted.length,
      },
    ];
  });
}

function successRate(counts: { succeeded: number; failed: number }): number | null {
  return ratio(counts.succeeded, counts.succeeded + counts.failed);
}

function kpi(available: boolean, value: number | null, previous: number | null): KpiDto {
  return available ? { value, previous } : { value: null, previous: null };
}

function dataset<T>(reason: UnavailableReason | null, rows: () => T[]): Dataset<T> {
  return reason === null ? rows() : { unavailable: reason };
}

function tenantRow(aggregate: TenantAggregate): TenantRowDto {
  const end = aggregate.levels.end;
  return {
    id: aggregate.tenant.id,
    name: aggregate.tenant.name,
    objects: end.protectedObjects,
    successRate: successRate(aggregate.backupTotals.current),
    logicalBytes: end.logicalBytes,
    physicalBytes: end.physicalBytes,
    readiness: aggregate.overallEnd,
    failures: aggregate.failedItems.current,
  };
}

export interface BuildInput {
  readonly period: ResolvedPeriod;
  readonly scope: StatsScopeName;
  /** One entry in the tenant scope; every managed tenant in the provider scope. */
  readonly tenants: readonly TenantAggregate[];
  readonly generatedAt: Date;
}

export function buildStats(input: BuildInput): StatsDto {
  const { period, scope } = input;
  const totals: Totals =
    input.tenants.length === 1
      ? (input.tenants[0] as TenantAggregate)
      : mergeTotals(input.tenants, period.buckets.length);
  const none = input.tenants.length === 0;
  const { objects, backups, microsoft365 } = totals.available;
  const reasonWithout = (source: boolean, reason: UnavailableReason): UnavailableReason | null =>
    none ? "no_tenants" : source ? null : reason;
  const noObjects = reasonWithout(objects, "no_protected_objects");
  const noBackups = reasonWithout(backups, "no_backups_yet");
  const noGraph = reasonWithout(microsoft365, "no_microsoft_365_source");
  const noTenants = none ? "no_tenants" : null;
  const t = (index: number) => (period.buckets[index] as { t: string }).t;
  const { start, end } = totals.levels;

  const stats: StatsDto = {
    period: {
      from: period.current.from,
      to: period.current.to,
      granularity: period.granularity,
      days: period.current.days,
    },
    previous: { from: period.previous.from, to: period.previous.to },
    scope,
    kpis: {
      backupSuccessRate: kpi(
        noObjects === null,
        successRate(totals.backupTotals.current),
        successRate(totals.backupTotals.previous),
      ),
      protectedObjects: kpi(noTenants === null, end.protectedObjects, start.protectedObjects),
      logicalBytes: kpi(noBackups === null, end.logicalBytes, start.logicalBytes),
      physicalBytes: kpi(noBackups === null, end.physicalBytes, start.physicalBytes),
      dedupRatio: kpi(
        noBackups === null,
        ratio(end.retainedBytes, end.physicalBytes, 2),
        ratio(start.retainedBytes, start.physicalBytes, 2),
      ),
      restores: kpi(
        noBackups === null,
        totals.restoreTotals.current.completed + totals.restoreTotals.current.failed,
        totals.restoreTotals.previous.completed + totals.restoreTotals.previous.failed,
      ),
      verifiedShare: kpi(
        noObjects === null,
        ratio(provenCount(totals.readinessEnd), countedTotal(totals.readinessEnd)),
        ratio(provenCount(totals.readinessStart), countedTotal(totals.readinessStart)),
      ),
      throttlingWaitSeconds: kpi(
        noGraph === null,
        round(totals.throttlingTotals.current.waitMs / 1000, 1),
        round(totals.throttlingTotals.previous.waitMs / 1000, 1),
      ),
      failedItems: kpi(noObjects === null, totals.failedItems.current, totals.failedItems.previous),
    },
    series: {
      backups: dataset(noObjects, () =>
        totals.backups.map((counts, index) => ({ t: t(index), ...counts })),
      ),
      volume: dataset(noBackups, () =>
        totals.volume.map((bytes, index) => ({ t: t(index), ...bytes })),
      ),
      storage: dataset(noBackups, () =>
        totals.storage.map((bytes, index) => ({ t: t(index), bytes })),
      ),
      jobDurations: dataset(noTenants, () => jobDurations(totals.durations)),
      throttling: dataset(noGraph, () =>
        totals.throttling.map((counts, index) => ({
          t: t(index),
          waitSeconds: round(counts.waitMs / 1000, 1),
          events: counts.events,
        })),
      ),
      restores: dataset(noBackups, () =>
        totals.restores.map((counts, index) => ({ t: t(index), ...counts })),
      ),
      readiness: dataset(noObjects, () =>
        totals.readiness.map((counts, index) => ({ t: t(index), ...counts })),
      ),
    },
    tables: {
      failuresByCause: dataset(noObjects, () =>
        sortCauses(totals.causes)
          .slice(0, MAX_CAUSES)
          .map((cause) => ({
            cause: cause.cause,
            count: cause.count,
            lastAt: cause.lastAt.toISOString(),
          })),
      ),
      largestObjects: dataset(noBackups, () => totals.largest),
    },
    generatedAt: input.generatedAt.toISOString(),
  };
  if (scope === "provider") {
    stats.tables.tenants = dataset(noTenants, () =>
      [...input.tenants]
        .sort(
          (a, b) =>
            a.tenant.name.localeCompare(b.tenant.name, "en") ||
            (a.tenant.id < b.tenant.id ? -1 : 1),
        )
        .map(tenantRow),
    );
  }
  return stats;
}
