import type { JobState } from "@/features/backup-jobs/api";
import type { Failure } from "@/features/failures/api";
import type { JobPhase, JobThrottle } from "@/features/jobs/api";
import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/history and the shapes of the live channel
 * (apps/api/src/features/history: dto.ts, live.ts). The shapes mirror the API one to one; all
 * times are ISO 8601 in UTC. Query keys carry the tenant, so a tenant switch never shows
 * another tenant's runs.
 */

export const RUN_CATEGORIES = [
  "backup",
  "restore",
  "restore_check",
  "export",
  "import",
  "maintenance",
] as const;
export type RunCategory = (typeof RUN_CATEGORIES)[number];

/** `file_share`: a backup, restore or copy run of a file share (docs/FILESHARES.md 13). */
export type RunSource = "mail" | "endpoint" | "file_share";

/** `succeeded` is a run that completed; the restore check says whether the backup is restorable. */
export type RunState = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

export type SubjectKind =
  | "mailbox"
  | "onedrive"
  | "imap"
  | "site"
  | "group"
  | "server"
  | "client"
  | "file_share";

export interface RunSubject {
  kind: SubjectKind;
  id: string;
  name: string;
  /** The address of a mailbox, the operating system of a machine, the location of a file share. */
  detail: string | null;
}

export interface RunProgress {
  /** 0 to 100; null while the run does not know its size. */
  percent: number | null;
  itemsDone: number;
  itemsTotal: number | null;
  itemsFailed: number;
  bytesProcessed: number;
  bytesTransferred: number;
  bytesNew: number | null;
  bytesTotal: number | null;
  etaSeconds: number | null;
  currentPath: string | null;
  updatedAt: string | null;
}

/** A running first backup over all its attempts (#47). */
export interface RunFirstBackup {
  itemsDone: number;
  /** Null when the source gives no total up front (a OneDrive); then there is no estimate either. */
  itemsTotal: number | null;
  /** Seconds left at the rate this attempt observed: an estimate. */
  etaSeconds: number | null;
}

export interface RunAttempt {
  number: number;
  of: number;
}

/** Cumulative bytes at a moment: `[epoch ms, processed, transferred]`. */
export type SamplePoint = readonly [at: number, processed: number, transferred: number];

export interface Run {
  id: string;
  source: RunSource;
  kind: RunCategory;
  /** The job queue (mail) or the agent's run kind (machines). */
  type: string;
  state: RunState;
  checkIncomplete: boolean;
  /**
   * A failed run that Microsoft Graph or the storage held back (throttled, unavailable): no
   * fault of the object, the next run tries again. Missing on servers before 0.4.7.
   */
  serviceLimited?: boolean;
  attempt: RunAttempt | null;
  subject: RunSubject | null;
  job: { id: string; name: string } | null;
  trigger: "scheduled" | "manual" | "after_backup";
  full: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  progress: RunProgress | null;
  /** A running first backup of a mailbox or OneDrive; null otherwise, missing on servers before 0.3.7. */
  firstBackup?: RunFirstBackup | null;
  throughput: { processedBps: number; transferredBps: number } | null;
  samples: SamplePoint[] | null;
  phase: JobPhase | null;
  throttle: JobThrottle | null;
  errorMessage: string | null;
  failure: Failure | null;
  /** The run can be stopped now (mail, a machine's backup, a share's run; 0.4.2 for the latter two). */
  cancellable: boolean;
  /** A stop was asked for and the run has not ended yet; missing on older servers. */
  cancelling?: boolean;
  /** Who stopped it (machines), for "Cancelled by ...". */
  cancelledBy?: string | null;
}

export type RestoreCheckState =
  | "passed"
  | "warning"
  | "failed"
  | "queued"
  | "running"
  | "unverified"
  | "none";

export interface RunRestoreCheck {
  state: RestoreCheckState;
  checkedAt: string | null;
  runId: string | null;
}

export interface RunObject {
  runId: string | null;
  subject: RunSubject;
  state: RunState;
  /** Its backup a service held back (`Run.serviceLimited`); missing on servers before 0.4.7. */
  serviceLimited?: boolean;
  restoreCheck: RunRestoreCheck;
  current: boolean;
}

export interface RunBatch {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  partial: number;
  failed: number;
  /** Failed backups a service held back, not in `failed`; missing on servers before 0.4.7. */
  limited?: number;
  cancelled: number;
  truncated: boolean;
}

export type RunEventType =
  | "queued"
  | "started"
  | "phase"
  | "throttled"
  | "item_failed"
  | "completed"
  | "failed"
  | "cancelled"
  | "agent_error"
  | "finished"
  | "restore_check_queued"
  | "restore_check_running"
  | "restore_check_passed"
  | "restore_check_warning"
  | "restore_check_failed";

export interface RunEvent {
  at: string;
  type: RunEventType;
  params: Record<string, string | number | boolean | null>;
  durationMs: number | null;
}

export interface RunSummary {
  itemsWritten: number | null;
  itemsTotal: number | null;
  filesNew: number | null;
  filesChanged: number | null;
  bytesNew: number | null;
  snapshot: { id: string; sequence: number | null } | null;
  throttleWaits: number;
  throttleWaitMs: number;
}

export interface RunError {
  path: string | null;
  message: string;
  /** Mail: the classified cause; machines: the agent's own error code. */
  code: string | null;
  /** The classified cause for both (absent from an older server). */
  cause?: string | null;
}

export interface RunDetail extends Run {
  summary: RunSummary | null;
  restoreCheck: RunRestoreCheck;
  batch: RunBatch | null;
  objects: RunObject[];
  events: RunEvent[];
  errors: RunError[];
  errorCount: number;
  logTail: string | null;
  docsUrl: string;
}

export interface HistoryPage {
  items: Run[];
  next: string | null;
}

export interface HistoryFilters {
  /** The tab; null shows every kind of run. */
  type: RunCategory | null;
  /** Only the runs of this backup job. */
  job: string | null;
}

export const HISTORY_PAGE_SIZE = 50;

// --- Live channel shapes (apps/api history/live.ts) ----------------------------------------

export interface BackupJobLive {
  id: string;
  kind: "mail" | "endpoint" | "share" | "copy";
  enabled: boolean;
  state: JobState;
  scope: { count: number; byKind: Record<string, number>; overrides: number };
  lastRun: {
    at: string | null;
    failed: number;
    partial: number;
    running: number;
    queued: number;
    runId: string | null;
  };
  nextRunAt: string | null;
  restoreCheck: {
    passed: number;
    warning: number;
    failed: number;
    unverified: number;
    noBackup: number;
    total: number;
    checkedAt: string | null;
  };
  updatedAt: string;
}

export interface MachineLive {
  id: string;
  status: "active" | "revoked";
  connection: "online" | "offline" | "never";
  agentState: "idle" | "running" | null;
  lastSeenAt: string | null;
  lastBackupAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
}

export interface LiveSnapshot {
  runs: Run[];
  definitions: BackupJobLive[];
  machines: MachineLive[];
  serverTime: string;
}

// --- Query keys -----------------------------------------------------------------------------

type TenantKey = string | null;

export const historyKeys = {
  all: (tenantId: TenantKey) => ["tenant", tenantId, "history"] as const,
  lists: (tenantId: TenantKey) => ["tenant", tenantId, "history", "list"] as const,
  list: (tenantId: TenantKey, filters: HistoryFilters) =>
    ["tenant", tenantId, "history", "list", filters.type ?? "all", filters.job ?? "all"] as const,
  detail: (tenantId: TenantKey, runId: string) =>
    ["tenant", tenantId, "history", "detail", runId] as const,
  /** Every run the live channel follows, keyed by id: what rows and the drawer read. */
  live: (tenantId: TenantKey) => ["tenant", tenantId, "history", "live"] as const,
  /** The newest runs of one backup job, for its detail panel on the job lists (0.4.5). */
  jobRuns: (tenantId: TenantKey, jobId: string) =>
    ["tenant", tenantId, "history", "job-runs", jobId] as const,
  /** Every backup job as the live channel last described it, keyed by id (the sidebar's counts). */
  liveDefinitions: (tenantId: TenantKey) =>
    ["tenant", tenantId, "history", "live-definitions"] as const,
};

// --- Requests ---------------------------------------------------------------------------------

export function fetchHistory(
  filters: HistoryFilters,
  cursor: string | null,
  limit: number = HISTORY_PAGE_SIZE,
): Promise<HistoryPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.type) {
    params.set("type", filters.type);
  }
  if (filters.job) {
    params.set("job", filters.job);
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  return apiFetch<HistoryPage>(`/history?${params.toString()}`);
}

export function fetchRunDetail(runId: string): Promise<RunDetail> {
  return apiFetch<RunDetail>(`/history/${encodeURIComponent(runId)}`);
}

/** The path of the live channel (relative to /api/v1). One stream per tab. */
export const LIVE_PATH = "/live";
