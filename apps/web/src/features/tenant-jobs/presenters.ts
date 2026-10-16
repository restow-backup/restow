import {
  TENANT_JOB_KINDS,
  type TenantJobKind,
  type TenantJobOutcome,
  type TenantJobSummary,
} from "./api.js";

/**
 * What a tenant's row in the "All tenants" view of Jobs says, and which rows show in which
 * order. Pure functions over the API's shapes, tested directly.
 */

export interface TenantJobFacts {
  /** Jobs per kind. */
  jobs: Record<TenantJobKind, number>;
  total: number;
  paused: number;
  running: number;
  queued: number;
  /** The worst outcome over every kind; null while no backup finished. */
  outcome: TenantJobOutcome | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

const OUTCOME_WEIGHT: Record<TenantJobOutcome, number> = { failed: 3, warning: 2, succeeded: 1 };

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/** The figures of every kind added up; null when the tenant's figures could not be read. */
export function tenantJobFacts(summary: TenantJobSummary | undefined): TenantJobFacts | null {
  if (summary?.state !== "ok" || !summary.kinds) {
    return null;
  }
  const facts: TenantJobFacts = {
    jobs: { mail: 0, endpoint: 0, pve: 0 },
    total: 0,
    paused: 0,
    running: 0,
    queued: 0,
    outcome: null,
    lastRunAt: null,
    nextRunAt: null,
  };
  for (const kind of TENANT_JOB_KINDS) {
    const figures = summary.kinds[kind];
    facts.jobs[kind] = figures.jobs;
    facts.total += figures.jobs;
    facts.paused += figures.paused;
    facts.running += figures.running;
    facts.queued += figures.queued;
    if (
      figures.outcome &&
      (facts.outcome === null || OUTCOME_WEIGHT[figures.outcome] > OUTCOME_WEIGHT[facts.outcome])
    ) {
      facts.outcome = figures.outcome;
    }
    facts.lastRunAt = latest(facts.lastRunAt, figures.lastRunAt);
    facts.nextRunAt = earliest(facts.nextRunAt, figures.nextRunAt);
  }
  return facts;
}

export const TENANT_JOB_FILTERS = ["all", "running", "failures", "noJobs"] as const;
export type TenantJobFilter = (typeof TENANT_JOB_FILTERS)[number];

export const TENANT_JOB_SORTS = ["name", "attention", "nextRun"] as const;
export type TenantJobSort = (typeof TENANT_JOB_SORTS)[number];

export function isTenantJobFilter(value: unknown): value is TenantJobFilter {
  return (TENANT_JOB_FILTERS as readonly unknown[]).includes(value);
}

export function isTenantJobSort(value: unknown): value is TenantJobSort {
  return (TENANT_JOB_SORTS as readonly unknown[]).includes(value);
}

/** Whether a row passes the filter. A tenant whose figures are missing only shows under "all". */
export function matchesFilter(facts: TenantJobFacts | null, filter: TenantJobFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return facts !== null && facts.running > 0;
    case "failures":
      return facts?.outcome === "failed";
    case "noJobs":
      return facts !== null && facts.total === 0;
  }
}

/** Worst first: failures, figures that could not be read, warnings, running, waiting, the rest. */
export function attentionRank(facts: TenantJobFacts | null): number {
  if (facts === null) return 1;
  if (facts.outcome === "failed") return 0;
  if (facts.outcome === "warning") return 2;
  if (facts.running > 0) return 3;
  if (facts.queued > 0) return 4;
  return 5;
}

export interface TenantJobRow<T extends { name: string }> {
  tenant: T;
  facts: TenantJobFacts | null;
}

/**
 * The rows in the chosen order. `name` keeps the order they came in (the own organisation
 * first, then by name, as everywhere tenants are listed); the others fall back to it on a tie.
 */
export function sortRows<T extends { name: string }>(
  rows: readonly TenantJobRow<T>[],
  sort: TenantJobSort,
): TenantJobRow<T>[] {
  const indexed = rows.map((row, index) => ({ row, index }));
  const nextAt = (row: TenantJobRow<T>) =>
    row.facts?.nextRunAt ? Date.parse(row.facts.nextRunAt) : Number.POSITIVE_INFINITY;
  indexed.sort((a, b) => {
    if (sort === "attention") {
      const rank = attentionRank(a.row.facts) - attentionRank(b.row.facts);
      if (rank !== 0) return rank;
    } else if (sort === "nextRun") {
      const diff = nextAt(a.row) - nextAt(b.row);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
    }
    return a.index - b.index;
  });
  return indexed.map(({ row }) => row);
}

/**
 * Refresh more often while something runs or waits somewhere, now and then otherwise. The server
 * reads each tenant's figures at most every 30 seconds for all viewers (apps/api tenant-jobs
 * figures-cache.ts), so asking more often than every 15 seconds would show nothing new.
 */
export const ACTIVE_REFRESH_MS = 15_000;
export const IDLE_REFRESH_MS = 60_000;

export function refreshIntervalOf(summaries: readonly TenantJobSummary[] | undefined): number {
  const busy = (summaries ?? []).some((summary) => {
    const facts = tenantJobFacts(summary);
    return facts !== null && (facts.running > 0 || facts.queued > 0);
  });
  return busy ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
}

/** Badge tone of an outcome: a backup that went through is not proof, so never green. */
export function outcomeTone(
  outcome: TenantJobOutcome | null,
): "destructive" | "warning" | "neutral" | "muted" {
  switch (outcome) {
    case "failed":
      return "destructive";
    case "warning":
      return "warning";
    case "succeeded":
      return "neutral";
    default:
      return "muted";
  }
}
