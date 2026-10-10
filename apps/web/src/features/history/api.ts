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

export type RunSource = "mail" | "endpoint";

/** `succeeded` is a run that completed; the restore check says whether the backup is restorable. */
export type RunState = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

export type SubjectKind = "mailbox" | "onedrive" | "imap" | "server" | "client";

export interface RunSubject {
  kind: SubjectKind;
  id: string;
  name: string;
  /** The address of a mailbox, the operating system of a machine. */
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
  throughput: { processedBps: number; transferredBps: number } | null;
  samples: SamplePoint[] | null;
  phase: JobPhase | null;
  throttle: JobThrottle | null;
  errorMessage: string | null;
  failure: Failure | null;
  cancellable: boolean;
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
};

// --- Requests ---------------------------------------------------------------------------------

export function fetchHistory(filters: HistoryFilters, cursor: string | null): Promise<HistoryPage> {
  const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
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
