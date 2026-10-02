import type { ItemFailure, Job, JobProgress, Snapshot } from "@restow/db";
import { type FailureDto, type FailureGroupDto, failureDto } from "../failures/dto.js";
import type {
  ObjectVerification,
  ReportFact,
  SnapshotVerificationDto,
} from "../verify/verification-state.js";
import type { JOB_QUEUES, JOB_STATUSES } from "./schemas.js";

/**
 * The jobs feature's response shapes and the pure mapping from rows to them.
 *
 * Besides the columns, the worker leaves two documents in `jobs.payload`
 * (apps/worker/src/handlers/backup.ts): `runtime` (current phase and the
 * current or last Graph throttling wait) while a backup, restore or directory
 * sync runs, and `result` (snapshot, counts, throttling totals) once a backup
 * finished. They are read defensively: a malformed document yields null,
 * never a broken response.
 */

export type JobQueueName = (typeof JOB_QUEUES)[number];
export type JobStatusName = (typeof JOB_STATUSES)[number];
export type ProtectedObjectKindName = "mailbox" | "onedrive" | "imap";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface JobProgressDto {
  total: number;
  done: number;
  failed: number;
  bytes: number;
  etaSeconds: number | null;
  updatedAt: string;
}

/** The engine phase the worker recorded (`jobs.payload.runtime`). */
export interface JobPhaseDto {
  name: string;
  since: string | null;
}

/** The current (or last) wait Microsoft Graph imposed on a running job. */
export interface JobThrottleDto {
  status: number;
  waitMs: number;
  retryAfterMs: number | null;
  /** End of the current wait; after it, the job is working again. */
  until: string;
  waits: number;
  totalWaitMs: number;
}

export interface JobObjectDto {
  id: string;
  /** The source the object belongs to, so a failure can link to it. */
  sourceId: string;
  kind: ProtectedObjectKindName;
  displayName: string | null;
  externalId: string;
  status: "active" | "excluded" | "orphaned";
}

export interface JobDto {
  id: string;
  queue: JobQueueName;
  status: JobStatusName;
  protectedObjectId: string | null;
  object: JobObjectDto | null;
  scheduleId: string | null;
  /** The backup job (definition) the run belongs to, when it was queued for one. */
  backupJobId: string | null;
  /** What started the job: a schedule, a person, or the worker right after a backup. */
  trigger: "scheduled" | "manual" | "after_backup";
  /** Backup jobs: a full re-enumeration was requested. */
  full: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  /**
   * Why the job failed (or its last attempt failed), classified: a stable code,
   * parameters, technical details, the steps to take and the automatic retry
   * state. Null for a job that did not fail and for rows from before failure
   * records existed (those keep only `errorMessage`).
   */
  failure: FailureDto | null;
  /**
   * The causes behind the failed items of a finished job, most frequent first
   * (at most three, structured causes only): "12 items: item too large".
   * Empty while nothing failed or when only unclassified failures exist.
   */
  itemCauses: ItemCauseCountDto[];
  progress: JobProgressDto | null;
  phase: JobPhaseDto | null;
  throttle: JobThrottleDto | null;
  cancellable: boolean;
  retryable: boolean;
  /**
   * A restore check (queue `verify`) whose last attempt could not complete: the
   * storage did not answer (or the test restore could not reach its target)
   * and nothing read proved damage, so it rated nothing and left the last
   * result as it was. It is repeated automatically. Shown neutrally, never as
   * failed. False for every other job, and while the job runs.
   */
  checkIncomplete: boolean;
}

/** How many items failed for one cause code. */
export interface ItemCauseCountDto {
  code: string;
  count: number;
}

export interface ItemFailureDto {
  id: string;
  itemRef: string;
  reason: string;
  /** The classified cause behind `reason`; null when the engine only had text (or an older row). */
  failure: FailureDto | null;
  attempts: number;
  lastAttemptAt: string | null;
}

/**
 * Where a snapshot stands. `running` and `incomplete` have no manifest yet:
 * the first while its job still runs, the second when the job ended without
 * committing one (the snapshot is not restorable and says so).
 */
export type SnapshotState = "running" | "completed" | "incomplete" | "pruned";

export interface JobSnapshotDto {
  id: string;
  sequence: number;
  state: SnapshotState;
  itemCount: number;
  byteSize: number;
  startedAt: string | null;
  completedAt: string | null;
  jobId: string | null;
}

/** What a finished backup stored (`jobs.payload.result`). */
export interface BackupResultDto {
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

export interface JobDetailDto extends JobDto {
  /** The troubleshooting page for more help, also for jobs that have no classified cause. */
  docsUrl: string;
  failures: ItemFailureDto[];
  /** Exact number of item failures, also when `failures` is capped. */
  failureCount: number;
  /**
   * The failed items grouped by cause, most frequent first: how many items
   * share each cause and the latest example with its details and steps. Only
   * items with a classified cause are grouped (`failureCount` counts all).
   */
  failureGroups: FailureGroupDto[];
  /** The snapshot a backup job produced (or is producing). */
  snapshot: JobSnapshotDto | null;
  result: BackupResultDto | null;
}

export type BackupBlockedReason = "excluded" | "orphaned" | "source_pending" | "source_disabled";
export type BackupSkipReason = BackupBlockedReason | "already_queued";

export interface BackupSkipDto {
  protectedObjectId: string;
  displayName: string | null;
  reason: BackupSkipReason;
}

export interface StartBackupResult {
  queued: JobDto[];
  skipped: BackupSkipDto[];
}

/**
 * The rating of an object's newest backup (see verify/verification-state.ts).
 * `latestVerify` is null while that backup is not verified yet, even when an
 * older backup was checked, so no view shows a newer backup as proven.
 */
export interface VerifySummaryDto {
  kind: "verify" | "health_check";
  recoveryReadiness: "green" | "yellow" | "red";
  checkedAt: string;
}

/** A snapshot in an object's history, with the verification of exactly that backup. */
export interface SnapshotHistoryEntryDto extends JobSnapshotDto {
  /**
   * `unverified` until a restore check read this snapshot back; null for
   * snapshots that cannot be restored (running, incomplete, pruned).
   */
  verification: SnapshotVerificationDto | null;
}

export interface BackupTargetDto {
  id: string;
  kind: ProtectedObjectKindName;
  displayName: string | null;
  externalId: string;
  status: "active" | "excluded" | "orphaned";
  source: { id: string; name: string; kind: "m365" | "imap"; status: string };
  /** Why "Backup now" is unavailable, or null when it may run. */
  blocked: BackupBlockedReason | null;
  lastSnapshot: JobSnapshotDto | null;
  lastJob: JobDto | null;
  latestVerify: VerifySummaryDto | null;
}

export interface SnapshotsDto {
  object: JobObjectDto;
  snapshots: SnapshotHistoryEntryDto[];
  latestVerify: VerifySummaryDto | null;
}

/** Who performs an action, for the audit log: a signed-in person or an integration key. */
export interface Actor {
  /** better-auth user id; null for an API key. */
  userId: string | null;
  /** Human-readable label: the user's email or `api-key:<id>`. */
  label: string;
  ip: string | null;
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<JobStatusName> = new Set(["completed", "failed", "cancelled"]);
const RETRYABLE_QUEUES: ReadonlySet<JobQueueName> = new Set(["backup", "verify"]);

export function isTerminalStatus(status: JobStatusName): boolean {
  return TERMINAL.has(status);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite number, or null for anything else (NaN, strings, missing). */
export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The phase the worker stored under `payload.runtime`, if it is well-formed. */
export function runtimePhaseOf(payload: Record<string, unknown> | null): JobPhaseDto | null {
  const runtime = record(payload?.runtime);
  const name = text(runtime?.phase);
  if (!runtime || !name) {
    return null;
  }
  return { name, since: text(runtime.phaseSince) };
}

/** The throttling state the worker stored under `payload.runtime.throttle`, if well-formed. */
export function runtimeThrottleOf(payload: Record<string, unknown> | null): JobThrottleDto | null {
  const throttle = record(record(payload?.runtime)?.throttle);
  if (!throttle) {
    return null;
  }
  const status = finiteNumber(throttle.status);
  const waitMs = finiteNumber(throttle.waitMs);
  const until = text(throttle.until);
  if (status === null || waitMs === null || until === null || Number.isNaN(Date.parse(until))) {
    return null;
  }
  return {
    status,
    waitMs,
    retryAfterMs: finiteNumber(throttle.retryAfterMs),
    until,
    waits: finiteNumber(throttle.waits) ?? 1,
    totalWaitMs: finiteNumber(throttle.totalWaitMs) ?? waitMs,
  };
}

/** The result a finished backup stored under `payload.result`, if well-formed. */
export function backupResultOf(
  queue: JobQueueName,
  payload: Record<string, unknown> | null,
): BackupResultDto | null {
  const result = record(payload?.result);
  if (queue !== "backup" || !result) {
    return null;
  }
  const snapshotId = text(result.snapshotId);
  const completedAt = text(result.completedAt);
  if (snapshotId === null || completedAt === null) {
    return null;
  }
  return {
    snapshotId,
    sequence: finiteNumber(result.sequence) ?? 0,
    objectsWritten: finiteNumber(result.objectsWritten) ?? 0,
    objectsTotal: finiteNumber(result.objectsTotal) ?? 0,
    bytes: finiteNumber(result.bytes) ?? 0,
    failures: finiteNumber(result.failures) ?? 0,
    repairedCopies: finiteNumber(result.repairedCopies) ?? 0,
    verifyJobId: text(result.verifyJobId),
    throttleWaits: finiteNumber(result.throttleWaits) ?? 0,
    throttleWaitMs: finiteNumber(result.throttleWaitMs) ?? 0,
    completedAt,
  };
}

export interface JobViewRow {
  job: Job;
  progress: JobProgress | null;
  object: JobObjectDto | null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Whether a finished job can be re-enqueued: backups and verifies of an object that still exists. */
export function isRetryable(
  job: Pick<Job, "queue" | "status">,
  object: JobObjectDto | null,
): boolean {
  return (
    (job.status === "failed" || job.status === "cancelled") &&
    RETRYABLE_QUEUES.has(job.queue) &&
    object !== null &&
    object.status === "active"
  );
}

export function toJobDto(row: JobViewRow, itemCauses: ItemCauseCountDto[] = []): JobDto {
  const { job, progress, object } = row;
  const payload = job.payload ?? null;
  const running = job.status === "active";
  return {
    id: job.id,
    queue: job.queue,
    status: job.status,
    protectedObjectId: job.protectedObjectId,
    object,
    scheduleId: text(payload?.scheduleId),
    backupJobId: text(payload?.backupJobId),
    trigger:
      payload?.afterBackup === true
        ? "after_backup"
        : text(payload?.scheduleId) !== null ||
            (text(payload?.backupJobId) !== null && payload?.runNow !== true)
          ? "scheduled"
          : "manual",
    full: payload?.full === true,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: iso(job.startedAt),
    completedAt: iso(job.completedAt),
    errorMessage: job.errorMessage,
    failure: failureDto(job.failure),
    itemCauses,
    progress: progress
      ? {
          total: progress.total,
          done: progress.done,
          failed: progress.failed,
          bytes: progress.bytes,
          etaSeconds: progress.etaSeconds,
          updatedAt: progress.updatedAt.toISOString(),
        }
      : null,
    // Only a running job has a phase or a wait; a stale one must not linger.
    phase: running ? runtimePhaseOf(payload) : null,
    throttle: running ? runtimeThrottleOf(payload) : null,
    cancellable: job.status === "queued" || job.status === "active",
    retryable: isRetryable(job, object),
    checkIncomplete:
      job.queue === "verify" && !running && record(payload?.result)?.incomplete === true,
  };
}

export function toFailureDto(row: ItemFailure): ItemFailureDto {
  return {
    id: row.id,
    itemRef: row.itemRef,
    reason: row.reason,
    failure: failureDto(row.failure),
    attempts: row.attempts,
    lastAttemptAt: iso(row.lastAttemptAt),
  };
}

/** Where a snapshot stands, from its row and the status of the job that produced it. */
export function snapshotStateOf(
  row: Pick<Snapshot, "status" | "manifestPath">,
  jobStatus: JobStatusName | null,
): SnapshotState {
  if (row.status === "pruned") {
    return "pruned";
  }
  if (row.manifestPath !== null) {
    return "completed";
  }
  return jobStatus === "queued" || jobStatus === "active" ? "running" : "incomplete";
}

export function toSnapshotDto(row: Snapshot, jobStatus: JobStatusName | null): JobSnapshotDto {
  return {
    id: row.id,
    sequence: row.sequence,
    state: snapshotStateOf(row, jobStatus),
    itemCount: row.itemCount,
    byteSize: row.byteSize,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    jobId: row.jobId,
  };
}

/**
 * A history entry: the snapshot and, when it can be restored, its own
 * verification (`unverified` when no check read it back).
 */
export function toSnapshotHistoryEntry(
  row: Snapshot,
  jobStatus: JobStatusName | null,
  verification: SnapshotVerificationDto | undefined,
): SnapshotHistoryEntryDto {
  const snapshot = toSnapshotDto(row, jobStatus);
  return {
    ...snapshot,
    verification:
      snapshot.state === "completed"
        ? (verification ?? { state: "unverified", checkedAt: null, reportId: null })
        : null,
  };
}

/** The rating of the newest backup as `latestVerify`; null while it is unverified. */
export function verifySummaryOf(
  verification: Pick<ObjectVerification<ReportFact>, "report"> | undefined,
): VerifySummaryDto | null {
  const report = verification?.report;
  return report
    ? {
        kind: report.kind,
        recoveryReadiness: report.readiness,
        checkedAt: report.checkedAt.toISOString(),
      }
    : null;
}

/**
 * Why an object cannot be backed up right now (mirrors the worker's own
 * check, so the API answers before a job is created that would only fail).
 */
export function backupBlockedReason(
  objectStatus: JobObjectDto["status"],
  sourceStatus: string,
): BackupBlockedReason | null {
  if (objectStatus === "excluded") {
    return "excluded";
  }
  if (objectStatus === "orphaned") {
    return "orphaned";
  }
  if (sourceStatus === "pending") {
    return "source_pending";
  }
  if (sourceStatus === "disabled") {
    return "source_disabled";
  }
  return null;
}
