import type { JobEndpointSettings, JobMemberOverrides, JobSchedule } from "@restow/core";

/**
 * What the backup jobs feature answers (docs/ARCHITECTURE.md, "Jobs"). The shapes are the
 * contract of the web app (apps/web/src/features/backup-jobs/api.ts mirrors them); all times are
 * ISO 8601 in UTC. Pure mapping lives here, the queries in service.ts.
 */

export type JobKindName = "mail" | "endpoint";
export type JobScopeMode = "all" | "selected";
export type JobOrigin = "user" | "migration";

/**
 * How a job stands, worst first:
 *   paused     switched off
 *   failing    the last backup of a member failed
 *   running    a backup is running now
 *   attention  something needs a look: a partial backup, a failed restore check, or nothing backed up yet
 *   empty      no object or machine in scope
 *   ok         nothing to report (this says the backups ran, not that they are restorable)
 */
export type JobState = "paused" | "failing" | "running" | "attention" | "empty" | "ok";

export interface RepositoryDto {
  /** The storage target; null when the tenant has none of its own (the installation default). */
  id: string | null;
  name: string | null;
  kind: "local" | "s3" | "installation_default";
  role: "primary" | "copy" | "previous" | null;
  status: "unverified" | "ok" | "error" | null;
}

export interface JobRetentionDto {
  /** Mail jobs: the snapshot retention policy the job names; null follows the tenant default. */
  policyId: string | null;
  /** The name of the policy that applies (the named one, else the tenant default); null when none exists. */
  policyName: string | null;
  /** Machine jobs: what the job sets for the repository of each machine; null leaves each machine's own. */
  keep: { keepDaily: number; keepWeekly: number; keepMonthly: number } | null;
}

export interface JobScopeDto {
  /** Objects or machines the job covers right now. */
  count: number;
  /** By kind: mailbox, onedrive, imap (mail) or server, client (machines). */
  byKind: Record<string, number>;
  /** Members that do something differently from the job. */
  overrides: number;
}

export interface JobLastRunDto {
  /** When the newest backup of a member finished; null when none did. */
  at: string | null;
  failed: number;
  partial: number;
  running: number;
  /**
   * The run to open for "the job's current or last run": a backup that is running now, else the
   * newest that finished; null when no member was ever backed up. History opens it by this id.
   */
  runId: string | null;
}

/** The restore checks of the scope: green only for a passed one (docs/TESTING.md). */
export interface JobRestoreCheckDto {
  passed: number;
  warning: number;
  failed: number;
  unverified: number;
  noBackup: number;
  total: number;
  /** When the newest check of any member ran. */
  checkedAt: string | null;
}

export interface BackupJobDto {
  id: string;
  kind: JobKindName;
  name: string;
  enabled: boolean;
  origin: JobOrigin;
  scopeMode: JobScopeMode;
  /** Null: no schedule, the job runs when someone starts it. */
  schedule: JobSchedule | null;
  /** Mail jobs: the restore-check schedule; null means no restore checks. Machine jobs: always null. */
  verifySchedule: JobSchedule | null;
  repository: RepositoryDto;
  retention: JobRetentionDto;
  scope: JobScopeDto;
  lastRun: JobLastRunDto;
  /** The next planned run; null when the job is paused, has no schedule or covers nothing. */
  nextRunAt: string | null;
  restoreCheck: JobRestoreCheckDto;
  state: JobState;
  settings: JobEndpointSettings;
  createdAt: string;
  updatedAt: string;
}

export interface BackupJobListDto {
  items: BackupJobDto[];
  /**
   * What no job covers: active mail objects, and machines that are in no job (they keep the
   * configuration they have; the page offers to put them into one).
   */
  uncovered: { mail: number; endpoint: number };
}

export type MemberKind = "mailbox" | "onedrive" | "imap" | "server" | "client";
export type MemberRestoreState = "green" | "yellow" | "red" | "unverified" | "no_backup";

export interface BackupJobMemberDto {
  /** The id of the protected object (mail) or the machine. */
  targetId: string;
  kind: MemberKind;
  /** The mailbox's display name or address, or the machine's name. */
  name: string;
  /** The address or the operating system. */
  detail: string | null;
  /** Mail: the object's status (`active`, `excluded`, `orphaned`); machines: `active`. */
  status: string;
  /** Whether the job acts on it now. */
  covered: boolean;
  /** False for an object an "all" job covers without a member row. */
  explicit: boolean;
  overrides: JobMemberOverrides;
  /** What it does: the job's values with its overrides on top. */
  effective: {
    schedule: JobSchedule | null;
    verifySchedule: JobSchedule | null;
    settings: JobEndpointSettings;
  };
  lastBackup: {
    at: string | null;
    outcome: "succeeded" | "partial" | "failed" | "running" | "queued" | null;
  };
  restoreCheck: { state: MemberRestoreState; checkedAt: string | null };
  nextRunAt: string | null;
}

export interface BackupJobMembersDto {
  mode: JobScopeMode;
  items: BackupJobMemberDto[];
}

export interface JobCandidateDto {
  targetId: string;
  kind: MemberKind;
  name: string;
  detail: string | null;
  status: string;
  /** The job it belongs to already (an object or machine has at most one). */
  job: { id: string; name: string } | null;
}

export interface JobCandidatesDto {
  items: JobCandidateDto[];
  /** All that match, which may be more than `items`. */
  total: number;
}

export interface JobDefaultsDto {
  kind: JobKindName;
  /** The zone the tenant works in (its time zone, else Europe/Berlin). */
  timeZone: string;
  /** The recommended schedule of a new job of this kind. */
  schedule: JobSchedule;
  /** Mail jobs: the recommended restore-check schedule; null for machine jobs. */
  verifySchedule: JobSchedule | null;
  /** Machine jobs: the folders and exclusions a new Linux server starts with; `{}` for mail jobs. */
  settings: JobEndpointSettings;
  /** The tenant's primary storage target: the only one jobs write to. */
  repository: RepositoryDto;
  retentionPolicies: { id: string; name: string; isDefault: boolean; cutoffDays: number | null }[];
  /** Machine jobs: what a machine keeps its repository with unless the job says otherwise. */
  endpointRetention: { keepDaily: number; keepWeekly: number; keepMonthly: number };
}

export interface JobRunDto {
  id: string;
  /** `mail`: a job of the queue (backup, verify); `endpoint`: a run an agent reported. */
  source: "mail" | "endpoint";
  /** Mail: the queue; machines: backup, restore or verify_sample. */
  type: string;
  status: string;
  targetId: string | null;
  targetName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface BackupJobRunsDto {
  items: JobRunDto[];
}

export interface RunBackupJobResult {
  /** Backups queued (mail) or requested (machines). */
  queued: number;
  skipped: {
    targetId: string;
    name: string | null;
    reason:
      | "already_queued"
      | "excluded"
      | "orphaned"
      | "source_pending"
      | "source_disabled"
      | "revoked"
      | "not_in_job";
  }[];
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();
export { iso };

/** Object kinds of mail jobs and machine profiles, as member kinds. */
export function memberKindOfObject(kind: "mailbox" | "onedrive" | "imap"): MemberKind {
  return kind;
}

/** What a job's counters say about its state; see {@link JobState}. */
export function jobStateOf(input: {
  enabled: boolean;
  scopeCount: number;
  failed: number;
  running: number;
  partial: number;
  restore: Pick<JobRestoreCheckDto, "failed" | "warning" | "unverified" | "noBackup">;
}): JobState {
  if (!input.enabled) {
    return "paused";
  }
  if (input.scopeCount === 0) {
    return "empty";
  }
  if (input.failed > 0) {
    return "failing";
  }
  if (input.running > 0) {
    return "running";
  }
  if (
    input.partial > 0 ||
    input.restore.failed > 0 ||
    input.restore.warning > 0 ||
    input.restore.noBackup > 0
  ) {
    return "attention";
  }
  return "ok";
}

/** The earliest of some times, ignoring the missing ones. */
export function earliestOf(times: readonly (Date | null)[]): Date | null {
  const known = times.filter((time): time is Date => time !== null);
  return known.length === 0 ? null : new Date(Math.min(...known.map((time) => time.getTime())));
}

/** The latest of some times, ignoring the missing ones. */
export function latestOf(times: readonly (Date | null)[]): Date | null {
  const known = times.filter((time): time is Date => time !== null);
  return known.length === 0 ? null : new Date(Math.max(...known.map((time) => time.getTime())));
}
