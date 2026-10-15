import type { JobSchedule, JobScopeMode, JobState } from "@/features/backup-jobs/api";
import { apiFetch } from "@/lib/api";
import type { SessionTenant } from "@/lib/session";

/**
 * The jobs of every tenant at a glance (#63), for the provider's "All tenants" view of Jobs.
 * Mirrors apps/api/src/features/tenant-jobs/dto.ts; all times are ISO 8601 in UTC.
 */

export const TENANT_JOB_KINDS = ["mail", "endpoint", "pve"] as const;
export type TenantJobKind = (typeof TENANT_JOB_KINDS)[number];

/** How the newest finished backups of a kind ended, worst first; null while none finished. */
export type TenantJobOutcome = "failed" | "warning" | "succeeded";

export interface TenantJobKindSummary {
  jobs: number;
  paused: number;
  running: number;
  queued: number;
  outcome: TenantJobOutcome | null;
  failed: number;
  warning: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface TenantJobSummary {
  tenantId: string;
  name: string;
  status: SessionTenant["status"];
  kind: SessionTenant["kind"];
  state: "ok" | "error";
  kinds: Record<TenantJobKind, TenantJobKindSummary> | null;
}

export interface TenantJobSummaries {
  generatedAt: string;
  tenants: TenantJobSummary[];
}

export interface TenantJobItem {
  id: string;
  kind: TenantJobKind;
  name: string;
  enabled: boolean;
  scopeMode: JobScopeMode;
  scopeCount: number;
  schedule: JobSchedule | null;
  lastRun: { at: string | null; failed: number; partial: number; running: number; queued: number };
  nextRunAt: string | null;
  state: JobState;
}

export interface TenantJobList {
  tenantId: string;
  items: TenantJobItem[];
}

export const tenantJobKeys = {
  all: ["tenant-jobs"] as const,
  summaries: () => [...tenantJobKeys.all, "summaries"] as const,
  tenant: (tenantId: string) => [...tenantJobKeys.all, "tenant", tenantId] as const,
};

/** Provider routes: they name no tenant in the header, the overview spans them. */
export const fetchTenantJobSummaries = () =>
  apiFetch<TenantJobSummaries>("/tenant-jobs", { tenantId: null });

export const fetchTenantJobs = (tenantId: string) =>
  apiFetch<TenantJobList>(`/tenant-jobs/${encodeURIComponent(tenantId)}`, { tenantId: null });
