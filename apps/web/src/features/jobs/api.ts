import type { Failure, FailureGroup, ItemCauseCount } from "@/features/failures/api";
import type { SnapshotVerification } from "@/features/verify/api";
import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/jobs (apps/api/src/features/jobs). The shapes
 * mirror the API DTOs (dto.ts there) one to one; query keys are scoped by
 * tenant so switching tenants never shows another tenant's jobs.
 */

export const JOB_QUEUES = [
  "backup",
  "restore",
  "verify",
  "archive",
  "directory",
  "retention",
  "scrub",
  "storage_migration",
] as const;
export type JobQueue = (typeof JOB_QUEUES)[number];

export const JOB_STATUSES = ["queued", "active", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const OBJECT_KINDS = ["mailbox", "onedrive", "imap"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export type ObjectStatus = "active" | "excluded" | "orphaned";

export interface JobProgress {
  total: number;
  done: number;
  failed: number;
  bytes: number;
  etaSeconds: number | null;
  updatedAt: string;
}

export interface JobPhase {
  name: string;
  since: string | null;
}

export interface JobThrottle {
  status: number;
  waitMs: number;
  retryAfterMs: number | null;
  until: string;
  waits: number;
  totalWaitMs: number;
}

export interface JobObject {
  id: string;
  /** The source the object belongs to; older servers omit it. */
  sourceId?: string;
  kind: ObjectKind;
  displayName: string | null;
  externalId: string;
  status: ObjectStatus;
}

export interface Job {
  id: string;
  queue: JobQueue;
  status: JobStatus;
  protectedObjectId: string | null;
  object: JobObject | null;
  scheduleId: string | null;
  /** Older servers omit it; the UI then falls back to `scheduleId`. */
  trigger?: "scheduled" | "manual" | "after_backup";
  full: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  /**
   * Why the job failed (or its last attempt did), classified, with steps and
   * retry state. Null for jobs that did not fail and for rows from before
   * causes were kept (then only `errorMessage` exists); older servers omit it.
   */
  failure?: Failure | null;
  /** The causes behind the failed items of a finished job, most frequent first. */
  itemCauses?: ItemCauseCount[];
  progress: JobProgress | null;
  phase: JobPhase | null;
  throttle: JobThrottle | null;
  cancellable: boolean;
  retryable: boolean;
  /**
   * A restore check whose last attempt could not complete (the storage did not
   * answer): it rated nothing and is repeated. Shown neutrally, never as failed.
   * Older servers omit it.
   */
  checkIncomplete?: boolean;
}

export interface ItemFailure {
  id: string;
  itemRef: string;
  reason: string;
  /** Why this item failed (classified); null when only the text exists. */
  failure?: Failure | null;
  attempts: number;
  lastAttemptAt: string | null;
}

export type SnapshotState = "running" | "completed" | "incomplete" | "pruned";

export interface JobSnapshot {
  id: string;
  sequence: number;
  state: SnapshotState;
  itemCount: number;
  byteSize: number;
  startedAt: string | null;
  completedAt: string | null;
  jobId: string | null;
}

export interface BackupResult {
  snapshotId: string;
  sequence: number;
  objectsWritten: number;
  objectsTotal: number;
  bytes: number;
  failures: number;
  repairedCopies: number;
  verifyJobId: string | null;
  throttleWaits: number;
  throttleWaitMs: number;
  completedAt: string;
}

export interface JobDetail extends Job {
  /** The troubleshooting page (configured on the server); older servers omit it. */
  docsUrl?: string;
  failures: ItemFailure[];
  failureCount: number;
  /** The failed items grouped by cause, most frequent first, each with an explained example. */
  failureGroups?: FailureGroup[];
  snapshot: JobSnapshot | null;
  result: BackupResult | null;
}

export type BackupBlockedReason = "excluded" | "orphaned" | "source_pending" | "source_disabled";
export type BackupSkipReason = BackupBlockedReason | "already_queued";

export interface BackupSkip {
  protectedObjectId: string;
  displayName: string | null;
  reason: BackupSkipReason;
}

export interface StartBackupResult {
  queued: Job[];
  skipped: BackupSkip[];
}

export type RecoveryReadiness = "green" | "yellow" | "red";

/**
 * The rating of an object's newest backup; `latestVerify` is null while that
 * backup is not verified yet, even when an older one was checked.
 */
export interface VerifySummary {
  kind: "verify" | "health_check";
  recoveryReadiness: RecoveryReadiness;
  checkedAt: string;
}

/** A snapshot in an object's history with its own verification (null when not restorable). */
export interface SnapshotHistoryEntry extends JobSnapshot {
  verification: SnapshotVerification | null;
}

export interface BackupTarget {
  id: string;
  kind: ObjectKind;
  displayName: string | null;
  externalId: string;
  status: ObjectStatus;
  source: { id: string; name: string; kind: "m365" | "imap"; status: string };
  blocked: BackupBlockedReason | null;
  lastSnapshot: JobSnapshot | null;
  lastJob: Job | null;
  latestVerify: VerifySummary | null;
}

export interface SnapshotHistory {
  object: JobObject;
  snapshots: SnapshotHistoryEntry[];
  latestVerify: VerifySummary | null;
}

export interface JobPage {
  items: Job[];
  next: string | null;
}

export interface JobFilters {
  queue: JobQueue | null;
  status: JobStatus | null;
}

export const JOBS_PAGE_SIZE = 50;

// --- Query keys ---------------------------------------------------------------

export const jobKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "jobs"] as const,
  list: (tenantId: string | null, filters: JobFilters) =>
    ["tenant", tenantId, "jobs", "list", filters.queue, filters.status] as const,
  detail: (tenantId: string | null, jobId: string) =>
    ["tenant", tenantId, "jobs", "detail", jobId] as const,
  objects: (tenantId: string | null) => ["tenant", tenantId, "jobs", "objects"] as const,
  snapshots: (tenantId: string | null, objectId: string, includePruned: boolean) =>
    ["tenant", tenantId, "jobs", "snapshots", objectId, includePruned] as const,
};

// --- Endpoints ----------------------------------------------------------------

export function fetchJobs(filters: JobFilters, cursor: string | null): Promise<JobPage> {
  const params = new URLSearchParams({ limit: String(JOBS_PAGE_SIZE) });
  if (filters.queue) {
    params.set("queue", filters.queue);
  }
  if (filters.status) {
    params.set("status", filters.status);
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  return apiFetch<JobPage>(`/jobs?${params.toString()}`);
}

export function fetchJob(jobId: string): Promise<JobDetail> {
  return apiFetch<JobDetail>(`/jobs/${encodeURIComponent(jobId)}`);
}

export async function fetchBackupTargets(): Promise<BackupTarget[]> {
  const page = await apiFetch<{ items: BackupTarget[] }>("/jobs/objects");
  return page.items;
}

export function fetchSnapshotHistory(
  objectId: string,
  includePruned: boolean,
): Promise<SnapshotHistory> {
  const params = new URLSearchParams({ includePruned: String(includePruned), limit: "200" });
  return apiFetch<SnapshotHistory>(
    `/jobs/objects/${encodeURIComponent(objectId)}/snapshots?${params.toString()}`,
  );
}

export function startBackup(input: {
  protectedObjectId?: string;
  full: boolean;
}): Promise<StartBackupResult> {
  return apiFetch<StartBackupResult>("/jobs/backup", { method: "POST", body: input });
}

export function cancelJob(jobId: string): Promise<Job> {
  return apiFetch<Job>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

export function retryJob(jobId: string): Promise<Job> {
  return apiFetch<Job>(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
}
