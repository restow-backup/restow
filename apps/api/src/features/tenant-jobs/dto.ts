import type { JobSchedule } from "@restow/core";
import type { TenantKind, TenantStatus } from "@restow/db";
import type { JobLastRunDto, JobScopeMode, JobState } from "../backup-jobs/dto.js";

/**
 * The jobs of every tenant at a glance, for the provider's "All tenants" view of Jobs (#63).
 * The shapes are the contract of the web app (apps/web/src/features/tenant-jobs/api.ts mirrors
 * them); all times are ISO 8601 in UTC.
 */

/** The kinds of job the overview counts: mail jobs, machine jobs and Proxmox VE jobs. */
export const TENANT_JOB_KINDS = ["mail", "endpoint", "pve"] as const;
export type TenantJobKind = (typeof TENANT_JOB_KINDS)[number];

/**
 * How the newest finished backups of a kind ended, worst first: `failed` when the newest backup
 * of at least one object, machine or guest in a job failed, `warning` when one left something
 * out, `succeeded` when every one of them went through, null while none finished. A backup that
 * went through is not proof of a restore: the web shows it neutral, never green.
 */
export type TenantJobOutcome = "failed" | "warning" | "succeeded";

/** One kind of job of one tenant, counted. */
export interface TenantJobKindSummaryDto {
  /** Jobs of this kind. */
  jobs: number;
  /** Of them switched off. */
  paused: number;
  /** Backups of this kind that run now. */
  running: number;
  /** Backups that were asked for and wait (a queued mail run, a machine or guest that has not started yet). */
  queued: number;
  outcome: TenantJobOutcome | null;
  /** Objects, machines or guests whose newest finished backup failed. */
  failed: number;
  /** Those whose newest finished backup left something out. */
  warning: number;
  /** When the newest of those backups finished. */
  lastRunAt: string | null;
  /** The earliest planned run of an enabled job of this kind. */
  nextRunAt: string | null;
}

export interface TenantJobSummaryDto {
  tenantId: string;
  name: string;
  status: TenantStatus;
  kind: TenantKind;
  /** `error`: this tenant's figures could not be read (the others still show). */
  state: "ok" | "error";
  /** Null when `state` is `error`. */
  kinds: Record<TenantJobKind, TenantJobKindSummaryDto> | null;
}

/** GET /api/v1/tenant-jobs */
export interface TenantJobSummariesDto {
  generatedAt: string;
  tenants: TenantJobSummaryDto[];
}

/** One job of one tenant, read-only, as the expanded row of the overview lists it. */
export interface TenantJobItemDto {
  id: string;
  kind: TenantJobKind;
  name: string;
  enabled: boolean;
  scopeMode: JobScopeMode;
  /** Objects, machines or guests the job covers now. */
  scopeCount: number;
  /** Null: no schedule, the job runs when someone starts it. */
  schedule: JobSchedule | null;
  lastRun: Pick<JobLastRunDto, "at" | "failed" | "partial" | "running" | "queued">;
  nextRunAt: string | null;
  state: JobState;
}

/** GET /api/v1/tenant-jobs/:tenantId */
export interface TenantJobListDto {
  tenantId: string;
  items: TenantJobItemDto[];
}

/** The outcome of a kind from what its newest finished backups counted. */
export function outcomeOf(counts: {
  failed: number;
  warning: number;
  succeeded: number;
}): TenantJobOutcome | null {
  if (counts.failed > 0) return "failed";
  if (counts.warning > 0) return "warning";
  if (counts.succeeded > 0) return "succeeded";
  return null;
}
