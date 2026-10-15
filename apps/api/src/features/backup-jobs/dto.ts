import type { JobSchedule } from "@restow/core";
import type { BackupJobMemberOverrides, BackupJobSettings } from "@restow/db";

/**
 * What the backup jobs feature answers (docs/ARCHITECTURE.md, "Jobs"). The shapes are the
 * contract of the web app (apps/web/src/features/backup-jobs/api.ts mirrors them); all times are
 * ISO 8601 in UTC. Pure mapping lives here, the queries in service.ts.
 */

export type JobKindName = "mail" | "endpoint" | "share" | "copy";

/** A job's settings as the API shows them: the fields of its kind (docs/FILESHARES.md 7.5). */
export type JobSettingsDto = BackupJobSettings;
/** A member's overrides (mail: schedules; machines and shares: settings, shares: include folders). */
export type JobMemberOverridesDto = BackupJobMemberOverrides;
export type JobScopeMode = "all" | "selected";
export type JobOrigin = "user" | "migration";

/**
 * How a job stands, worst first:
 *   paused         switched off
 *   empty          no object or machine in scope
 *   storage_error  its repository fails its check: backups cannot be written
 *   failing        the last backup of a member failed
 *   running        a backup is running now
 *   queued         a backup was requested and waits for the machine (it starts at the next check-in)
 *   overdue        it has a schedule, but its planned run is long past, or no backup finished for
 *                  much longer than the schedule allows
 *   manual         no schedule: nothing is backed up unless someone starts it
 *   attention      something needs a look: a partial backup, a failed restore check, or nothing backed up yet
 *   ok             nothing to report (this says the backups ran, not that they are restorable)
 */
export type JobState =
  | "paused"
  | "empty"
  | "storage_error"
  | "failing"
  | "running"
  | "queued"
  | "overdue"
  | "manual"
  | "attention"
  | "ok";

export interface RepositoryDto {
  /** The storage target; null when the tenant has none of its own (the installation default). */
  id: string | null;
  name: string | null;
  kind: "local" | "s3" | "installation_default";
  role: "primary" | "copy" | "previous" | null;
  status: "unverified" | "ok" | "error" | null;
  /**
   * Whether the target's bucket enforces S3 Object Lock (WORM): what the last
   * check of the target found. False for a local target; null for the
   * installation default, whose bucket this view does not know.
   */
  objectLock: boolean | null;
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
  /** Machines with a requested backup that waits for them (and no backup running): the agent starts it at its next check-in. */
  queued: number;
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
  /** Mail jobs: the job's mailboxes are expected in the journal archive (#32). Machine jobs: false. */
  archive: boolean;
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
  settings: JobSettingsDto;
  /**
   * Copy jobs (docs/FILESHARES.md 4.10): the two shares, the restore point copied last and the
   * mirror confirmation. "Not a backup: no versions on the target". Null for every other kind.
   */
  copy: CopyJobInfoDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface CopyJobInfoDto {
  source: { id: string; name: string; retired: boolean };
  target: { id: string; name: string; retired: boolean; allowRestore: boolean };
  mode: "overwrite" | "mirror";
  targetFolder: string;
  mirrorConfirmedAt: string | null;
  /** The restore point the last successful run copied (file_share_snapshots.id) and when. */
  lastCopied: { snapshotId: string | null; at: string | null } | null;
}

export interface BackupJobListDto {
  items: BackupJobDto[];
  /**
   * What no job covers: active mail objects, and machines that are in no job (they keep the
   * configuration they have; the page offers to put them into one).
   */
  uncovered: { mail: number; endpoint: number; share: number; copy: number };
  /**
   * What is in a job but still not backed up on a schedule: the job is paused or runs by hand
   * only (and the member has no schedule of its own).
   */
  unscheduled: { mail: number; endpoint: number; share: number; copy: number };
}

export type MemberKind = "mailbox" | "onedrive" | "imap" | "server" | "client" | "smb" | "nfs";
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
  overrides: JobMemberOverridesDto;
  /** What it does: the job's values with its overrides on top. */
  effective: {
    schedule: JobSchedule | null;
    verifySchedule: JobSchedule | null;
    settings: JobSettingsDto;
  };
  lastBackup: {
    /** When the newest backup finished; a queued backup does not change it. */
    at: string | null;
    /** `queued` while a requested backup waits for the machine and none is running. */
    outcome: "succeeded" | "partial" | "failed" | "running" | "queued" | null;
  };
  /**
   * Machines: the backup requested by hand that the machine has not started yet. `pending` is not
   * picked up by the agent yet, `delivered` is on the machine and starts. `nextCheckInAt` is when
   * the agent is expected to ask next (its last contact plus the check-in interval); null when
   * it never did.
   */
  pendingBackup: {
    status: "pending" | "delivered";
    requestedAt: string;
    nextCheckInAt: string | null;
  } | null;
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
  /**
   * Machine jobs: the folders and exclusions a new job starts with, those of a Linux server unless
   * `basis` names the machines' systems (then the union of their defaults); `{}` for mail jobs.
   */
  settings: JobSettingsDto;
  /**
   * Machine jobs started from chosen machines: their operating systems and profiles, which the
   * folders and the schedule follow (all clients: back up on connect). Null otherwise.
   */
  basis: { os: string[]; profiles: ("server" | "client")[]; mixed: boolean } | null;
  /** The tenant's primary storage target: the only one jobs write to. */
  repository: RepositoryDto;
  retentionPolicies: { id: string; name: string; isDefault: boolean; cutoffDays: number | null }[];
  /** Machine jobs: what a machine keeps its repository with unless the job says otherwise. */
  endpointRetention: { keepDaily: number; keepWeekly: number; keepMonthly: number };
}

export interface JobRunDto {
  id: string;
  /**
   * `mail`: a job of the queue (backup, verify); `endpoint`: a run an agent reported;
   * `file_share`: a backup or restore run of a share (a copy run is a restore run).
   */
  source: "mail" | "endpoint" | "file_share";
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
      | "retired"
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

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A planned run this far in the past did not happen; a little lateness is normal. */
export const OVERDUE_GRACE_MS = 60 * MINUTE_MS;

/** How often a schedule means to back up: an interval its minutes, a daily or cron schedule a day. */
export function schedulePeriodMs(schedule: Pick<JobSchedule, "kind" | "intervalMinutes">): number {
  if (
    (schedule.kind === "interval" || schedule.kind === "on_connect") &&
    schedule.intervalMinutes
  ) {
    return schedule.intervalMinutes * MINUTE_MS;
  }
  return DAY_MS;
}

/**
 * Whether a job with a schedule is behind it: its next planned run is more than
 * {@link OVERDUE_GRACE_MS} past (not for `on_connect`), or no backup finished (since the job exists) for more than one
 * period plus a day's slack (a laptop that was off for an evening is not overdue yet).
 */
export function isOverdue(input: {
  schedule: Pick<JobSchedule, "kind" | "intervalMinutes"> | null;
  nextRunAt: Date | string | null;
  lastAt: Date | string | null;
  createdAt: Date | string;
  now: Date;
}): boolean {
  if (!input.schedule) {
    return false;
  }
  const now = input.now.getTime();
  // A client that backs up when it connects has no fixed time to miss; only the age counts.
  if (
    input.schedule.kind !== "on_connect" &&
    input.nextRunAt &&
    now - new Date(input.nextRunAt).getTime() > OVERDUE_GRACE_MS
  ) {
    return true;
  }
  const since = new Date(input.lastAt ?? input.createdAt).getTime();
  const period = schedulePeriodMs(input.schedule);
  return now - since > period + Math.max(period, DAY_MS);
}

/** What a job's counters say about its state; see {@link JobState}. */
export function jobStateOf(input: {
  enabled: boolean;
  scopeCount: number;
  failed: number;
  running: number;
  queued?: number;
  partial: number;
  restore: Pick<JobRestoreCheckDto, "failed" | "warning" | "unverified" | "noBackup">;
  /** The job has no schedule (and no member one of its own): it runs only when started. */
  manual?: boolean;
  /** See {@link isOverdue}. */
  overdue?: boolean;
  /** The job's repository fails its check. */
  storageError?: boolean;
}): JobState {
  if (!input.enabled) {
    return "paused";
  }
  if (input.scopeCount === 0) {
    return "empty";
  }
  if (input.storageError) {
    return "storage_error";
  }
  if (input.failed > 0) {
    return "failing";
  }
  if (input.running > 0) {
    return "running";
  }
  if ((input.queued ?? 0) > 0) {
    return "queued";
  }
  if (input.overdue) {
    return "overdue";
  }
  if (input.manual) {
    return "manual";
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

/** How often the machine agent asks the server for work (agent/internal/core/agent.go, `HeartbeatInterval`). */
export const AGENT_CHECK_IN_MS = 5 * 60_000;

/** When the agent is expected to ask next: its last contact plus the check-in interval. */
export function nextCheckInOf(lastSeenAt: Date | null): Date | null {
  return lastSeenAt ? new Date(lastSeenAt.getTime() + AGENT_CHECK_IN_MS) : null;
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
