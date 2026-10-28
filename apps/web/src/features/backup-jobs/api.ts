import type { AgentPolicyValues, JobPolicyKey } from "@/features/endpoints/agent-policy";
import { apiFetch } from "@/lib/api";

import type { BandwidthWindow } from "./bandwidth-windows.js";

/**
 * Typed client for /api/v1/backup-jobs (apps/api/src/features/backup-jobs: dto.ts for
 * the responses, schemas.ts for the requests and their limits; packages/core
 * backup-jobs/types.ts for the schedule and the settings). The shapes mirror
 * the API one to one; all times are ISO 8601 in UTC. Query keys carry the
 * tenant so a tenant switch never shows another tenant's jobs.
 */

export type { BandwidthWindow } from "./bandwidth-windows.js";

export type JobKind = "mail" | "endpoint" | "share" | "copy";
/** The kinds the tenant's job card and the classic job lists show (mail and machines). */
export const JOB_KINDS: readonly JobKind[] = ["mail", "endpoint"];
/** Every kind: with file share jobs and their copies (docs/FILESHARES.md 7.5, 12.5, 12.6). */
export const ALL_JOB_KINDS: readonly JobKind[] = ["mail", "endpoint", "share", "copy"];

export type JobScopeMode = "all" | "selected";
export type JobOrigin = "user" | "migration";

/**
 * How a job stands, worst first: paused (switched off), failing (the last
 * backup of an object failed), running, queued (a machine
 * backup was requested and waits for the machine), attention (a partial backup, a failed
 * or missing restore check, or nothing backed up yet), empty (nothing in
 * scope), ok. `ok` says the backups ran, not that they are restorable.
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

// --- Schedule and settings (packages/core backup-jobs/types.ts) -------------------

/**
 * When a job (or one member) runs. Mail jobs: `interval` or `cron`; machine jobs:
 * `interval`, `daily` or `on_connect`. `timeZone` is the zone cron and `timeOfDay` are read in.
 */
export interface JobSchedule {
  kind: "interval" | "cron" | "daily" | "on_connect";
  /** `interval`: minutes between runs; `on_connect`: the least minutes between two backups. */
  intervalMinutes?: number;
  /** `cron`: five fields. */
  cron?: string;
  /** `daily`: local time `HH:MM`. */
  timeOfDay?: string;
  timeZone: string;
}

export interface JobRetention {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

/** What a machine job tells the agent to back up and how; a field left out keeps what the machine has. */
export interface JobEndpointSettings {
  paths?: string[];
  /** Exclude patterns, exactly as sent to the agent. */
  excludes?: string[];
  /** Skip files larger than this many GiB; null or absent = no limit. */
  excludeLargerThanGib?: number | null;
  hooks?: { pre?: string; post?: string };
  /**
   * Upload limit in kbit/s, the default outside every time window. Machine jobs: 0 = unlimited
   * even when the agent policy sets a limit; null or absent = the policy's limit (unlimited when
   * it sets none). File shares: null or absent = unlimited.
   */
  bandwidthKbps?: number | null;
  /**
   * Time windows with a limit of their own, read in the time zone of the job's schedule; the limit
   * in force when a run starts applies. Absent or empty = none.
   */
  bandwidthWindows?: BandwidthWindow[];
  retention?: JobRetention;
  /**
   * The job's level of the agent policy (docs/AGENT.md, "Richtlinien"): backup window, catching
   * up missed backups, AC power, retries; a key left out inherits from the tenant and the
   * installation. Machine jobs only, not per member.
   */
  policy?: Partial<Pick<AgentPolicyValues, JobPolicyKey>>;
  // --- File share jobs (docs/FILESHARES.md 7.5) ---
  /** "Skip temporary and system files" (default on). */
  presets?: { systemFiles?: boolean };
  /** File extensions to skip, without the dot. */
  fileTypes?: { exclude: string[] };
  /** restic's read concurrency; default the installation's. */
  readConcurrency?: number;
  /** Skip offline (tiered) files instead of recalling them (default on). */
  skipOffline?: boolean;
  // --- Copy jobs (4.10) ---
  /** Relative to the target share's root; never "" for a mirror. */
  targetFolder?: string;
  mode?: "overwrite" | "mirror";
  restorePermissions?: boolean;
  /** Set by the server when the admin confirmed a non-empty folder. */
  mirrorConfirmedAt?: string | null;
  verify?: boolean;
}

/** What one member does differently from the job; a field set here replaces the job's value. */
export type JobMemberOverrides = JobEndpointSettings & {
  schedule?: JobSchedule;
  /** Mail: its own restore-check schedule. */
  verifySchedule?: JobSchedule;
  /** File shares: the folders to back up, relative to the share root; empty = everything. */
  includes?: string[];
};

/** A copy job's shares and state (docs/FILESHARES.md 4.10); "Not a backup: no versions on the target". */
export interface CopyJobInfo {
  source: { id: string; name: string; retired: boolean };
  target: { id: string; name: string; retired: boolean; allowRestore: boolean };
  mode: "overwrite" | "mirror";
  targetFolder: string;
  mirrorConfirmedAt: string | null;
  lastCopied: { snapshotId: string | null; at: string | null } | null;
}

// --- Responses (apps/api backup-jobs/dto.ts) ----------------------------------------

export interface Repository {
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

export interface JobRetentionView {
  /** Mail jobs: the snapshot retention policy the job names; null follows the tenant default. */
  policyId: string | null;
  /** The name of the policy that applies; null when none exists. */
  policyName: string | null;
  /** Machine jobs: what the job sets for the repository of each machine; null leaves each machine's own. */
  keep: JobRetention | null;
}

export interface JobScope {
  /** Objects or machines the job covers right now. */
  count: number;
  /** By kind: mailbox, onedrive, imap (mail) or server, client (machines). */
  byKind: Record<string, number>;
  /** Members that do something differently from the job. */
  overrides: number;
}

export interface JobLastRun {
  /** When the newest backup of a member finished; null when none did. */
  at: string | null;
  failed: number;
  partial: number;
  running: number;
  /** Machines with a requested backup that waits for them (none running): it starts at their next check-in. */
  queued: number;
  /**
   * The run to open for "the job's current or last run": a backup that is running now, else the
   * newest that finished; null when no member was ever backed up.
   */
  runId: string | null;
}

/** The restore checks of the scope: green only for a passed one. */
export interface JobRestoreCheck {
  passed: number;
  warning: number;
  failed: number;
  unverified: number;
  noBackup: number;
  total: number;
  checkedAt: string | null;
}

export interface BackupJob {
  id: string;
  kind: JobKind;
  name: string;
  enabled: boolean;
  /** Mail jobs: the job's mail objects are archived (#32). Machine jobs: false. */
  archive: boolean;
  /**
   * Mail jobs: the archive's capture ways per kind of mail object, the defaults filled in
   * (docs/ARCHIVE.md "Erfassungswege"). Other kinds: `{}`. Absent from servers before 0.4.4.
   */
  archiveCapture?: ArchiveCaptureSettings;
  origin: JobOrigin;
  scopeMode: JobScopeMode;
  /** Null: no schedule, the job runs when someone starts it. */
  schedule: JobSchedule | null;
  /** Mail jobs: the restore-check schedule; null means no restore checks. Machine jobs: always null. */
  verifySchedule: JobSchedule | null;
  repository: Repository;
  retention: JobRetentionView;
  scope: JobScope;
  lastRun: JobLastRun;
  /** The next planned run; null when the job is paused, has no schedule or covers nothing. */
  nextRunAt: string | null;
  restoreCheck: JobRestoreCheck;
  state: JobState;
  settings: JobEndpointSettings;
  /** Copy jobs: the two shares and the copy's state; null for every other kind. */
  copy?: CopyJobInfo | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupJobList {
  items: BackupJob[];
  /** What no job covers: active mail objects, and machines that are in no job. */
  uncovered: { mail: number; endpoint: number; share?: number; copy?: number };
  /** In a job, but the job is paused or runs by hand only: not backed up on a schedule. */
  unscheduled?: { mail: number; endpoint: number; share?: number; copy?: number };
}

export type MemberKind =
  | "mailbox"
  | "onedrive"
  | "imap"
  | "site"
  | "group"
  | "server"
  | "client"
  | "smb"
  | "nfs";
export type MemberRestoreState = "green" | "yellow" | "red" | "unverified" | "no_backup";

/**
 * Which archive capture ways fit a mail object (apps/api backup-jobs dto.ts, packages/db
 * archive-capture.ts): `m365` a Microsoft 365 mailbox, `google` an IMAP account at Google,
 * `imap_microsoft` an IMAP account on a Microsoft host (a Microsoft 365 source fits better),
 * `imap` any other IMAP account.
 */
export type CaptureKind = "m365" | "google" | "imap" | "imap_microsoft";

/** A mail job's capture ways per kind of mail object (`imap_microsoft` uses `imap`). */
export interface ArchiveCaptureSettings {
  m365?: { graph: boolean; journal: boolean };
  /**
   * `pending`: the job archived before 0.4.4 and no way is chosen for the kind yet; nothing is
   * captured from these accounts until one is (the server drops the marker then).
   */
  imap?: { sync: boolean; forward: boolean; pending?: true };
  google?: { sync: boolean; forward: boolean; pending?: true };
}

export type MemberOutcome = "succeeded" | "partial" | "failed" | "running" | "queued" | "cancelled";

export interface JobMember {
  /** The id of the protected object (mail) or the machine. */
  targetId: string;
  kind: MemberKind;
  /** Mail objects: which archive capture ways fit it; null for OneDrive, sites and machines. */
  captureKind?: CaptureKind | null;
  name: string;
  /** The address or the operating system. */
  detail: string | null;
  /** Mail: `active`, `excluded` or `orphaned`; machines: `active`. */
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
  lastBackup: { at: string | null; outcome: MemberOutcome | null };
  /**
   * Machines: the backup requested by hand that the machine has not started yet. `pending` waits
   * for the next check-in (`nextCheckInAt`, null when the machine never contacted the server),
   * `delivered` is on the machine already.
   */
  pendingBackup: {
    status: "pending" | "delivered";
    requestedAt: string;
    nextCheckInAt: string | null;
  } | null;
  restoreCheck: { state: MemberRestoreState; checkedAt: string | null };
  nextRunAt: string | null;
}

export interface JobMembers {
  mode: JobScopeMode;
  items: JobMember[];
}

export interface JobCandidate {
  targetId: string;
  kind: MemberKind;
  /** Mail objects: which archive capture ways fit it; null otherwise. */
  captureKind?: CaptureKind | null;
  name: string;
  detail: string | null;
  status: string;
  /** The job it belongs to already (an object or machine has at most one). */
  job: { id: string; name: string } | null;
}

/** What the agent says the machine is (agent 0.4.0 and later). */
export interface MachineFacts {
  virtualization: "container" | "vm" | "none";
  /** `lxc`, `docker`, `kvm`, `vmware`, ...; empty when unknown. */
  technology: string;
  desktop: boolean;
}

/** Why enrollment gave a machine added as a client the server profile (#59). */
export interface ProfileDetection {
  requested: "server" | "client";
  reason: "container" | "vm";
  technology: string;
}

/** A machine of a job editor with the data folders its agent found (#59). */
export interface MachineFolders {
  endpointId: string;
  name: string;
  os: string;
  profile: "server" | "client";
  /** Data folders of the fixed list with files in them; null: the agent does not report them (before 0.4.0). */
  folders: string[] | null;
  reportedAt: string | null;
  machine: MachineFacts | null;
  profileDetection: ProfileDetection | null;
}

export interface JobCandidates {
  items: JobCandidate[];
  /** All that match, which may be more than `items`. */
  total: number;
}

export interface RetentionPolicyChoice {
  id: string;
  name: string;
  isDefault: boolean;
  cutoffDays: number | null;
}

export interface JobDefaults {
  kind: JobKind;
  /** The zone the tenant works in. */
  timeZone: string;
  /** The recommended schedule of a new job of this kind. */
  schedule: JobSchedule;
  /** Mail jobs: the recommended restore-check schedule; null for machine jobs. */
  verifySchedule: JobSchedule | null;
  /** Machine jobs: the folders and exclusions a new Linux server starts with; `{}` for mail jobs. */
  settings: JobEndpointSettings;
  /** Machine jobs started from chosen machines: their systems and profiles; null otherwise. */
  basis?: { os: string[]; profiles: ("server" | "client")[]; mixed: boolean } | null;
  /** The tenant's primary storage target: the only one jobs write to. */
  repository: Repository;
  /**
   * Mail jobs: the capture kinds of the tenant's active mail objects (what a job of scope
   * "all" archives). Empty for other kinds; absent from servers before 0.4.4.
   */
  mailSourceKinds?: CaptureKind[];
  retentionPolicies: RetentionPolicyChoice[];
  /** Machine jobs: what a machine keeps its repository with unless the job says otherwise. */
  endpointRetention: JobRetention;
}

export interface JobRun {
  id: string;
  /**
   * `mail`: a run of the queue (backup, restore check); `endpoint`: a run an agent reported;
   * `file_share`: a backup or restore of a share (a copy run is a restore run, type `copy`).
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

export interface JobRuns {
  items: JobRun[];
}

export type SkipReason =
  | "already_queued"
  | "excluded"
  | "orphaned"
  | "source_pending"
  | "source_disabled"
  | "revoked"
  | "retired"
  | "not_in_job";

export interface RunBackupJobResult {
  /** Backups queued (mail) or requested (machines). */
  queued: number;
  skipped: { targetId: string; name: string | null; reason: SkipReason }[];
}

// --- Requests (apps/api backup-jobs/schemas.ts) ---------------------------------------

export interface MemberInput {
  id: string;
  overrides?: JobMemberOverrides;
}

export interface CreateBackupJobInput {
  kind: JobKind;
  name: string;
  /** Null or absent: no schedule, the job runs when someone starts it (mail jobs only). */
  schedule?: JobSchedule | null;
  /** Mail jobs: the restore-check schedule; null or absent switches the checks off. */
  verifySchedule?: JobSchedule | null;
  scope?: { mode: JobScopeMode; members: MemberInput[] };
  /** Null or absent is the tenant's primary storage target, the only one written to. */
  storageTargetId?: string | null;
  /** Mail jobs: the snapshot retention policy; null or absent follows the tenant default. */
  retentionPolicyId?: string | null;
  settings?: JobEndpointSettings;
  enabled?: boolean;
  /** Mail jobs: archive the job's mail objects. */
  archive?: boolean;
  /** Mail jobs: how the archive captures each kind of mail object; absent = the defaults. */
  archiveCapture?: ArchiveCaptureSettings;
  /** Take objects and machines that belong to another job instead of refusing them. */
  moveMembers?: boolean;
  /** Copy jobs: the share copied from and the share copied into. */
  sourceFileShareId?: string;
  targetFileShareId?: string;
  /** Copy jobs in mirror mode: the admin confirmed a non-empty target folder. */
  confirmMirror?: boolean;
}

/** `settings` replaces the whole settings object: send all of it. */
export interface UpdateBackupJobInput {
  name?: string;
  schedule?: JobSchedule | null;
  verifySchedule?: JobSchedule | null;
  storageTargetId?: string | null;
  retentionPolicyId?: string | null;
  settings?: JobEndpointSettings;
  enabled?: boolean;
  archive?: boolean;
  archiveCapture?: ArchiveCaptureSettings;
  sourceFileShareId?: string;
  targetFileShareId?: string;
  confirmMirror?: boolean;
}

export interface ReplaceMembersInput {
  mode?: JobScopeMode;
  members: MemberInput[];
  move?: boolean;
}

export interface AddMembersInput {
  members: MemberInput[];
  move?: boolean;
}

export interface RunBackupJobInput {
  /** The objects or machines to run now; absent runs the whole job. */
  targetIds?: string[];
  /** Mail jobs: re-enumerate everything instead of continuing from the delta state. */
  full?: boolean;
  /** Copy jobs: "Copy anyway", past the guard against a source that lost half its files. */
  force?: boolean;
}

/** The API's limits (schemas.ts), so the UI stops before the request is refused. */
export const LIMITS = {
  name: 120,
  members: 5000,
  paths: 200,
  pathLength: 1024,
  excludes: 500,
  excludeLength: 512,
  excludeLargerThanGibMax: 1_000_000,
  hookLength: 4096,
  bandwidthMaxKbps: 10_000_000,
  /** Time windows of the bandwidth limit per job (and per machine's own setting). */
  bandwidthWindows: 24,
  keepDaily: 3650,
  keepWeekly: 520,
  keepMonthly: 240,
  /** A machine schedule's interval: 5 minutes to a week (the agent contract). */
  endpointIntervalMin: 5,
  endpointIntervalMax: 7 * 24 * 60,
  /** What the candidates request may ask for at most. */
  candidates: 500,
  runs: 100,
} as const;

/** The problem types the jobs API raises. */
export const INVALID_JOB_PROBLEM = "urn:restow:problem:invalid-backup-job";
export const IN_OTHER_JOB_PROBLEM = "urn:restow:problem:backup-job-member-in-other-job";
export const JOB_STATE_PROBLEM = "urn:restow:problem:backup-job-state";
/** A copy target that breaks a safety rule (docs/FILESHARES.md 4.10); `rule` names it. */
export const COPY_UNSAFE_TARGET_PROBLEM = "urn:restow:problem:file-share-copy-unsafe-target";
/** A mirror into a folder that is not empty: the admin confirms (`entries`, `folder`). */
export const COPY_CONFIRM_PROBLEM = "urn:restow:problem:file-share-copy-confirm";
export const RESTORE_NOT_ALLOWED_PROBLEM = "urn:restow:problem:file-share-restore-not-allowed";
/** A machine in a job gets its configuration from the job: its own `config` cannot be changed. */
export const ENDPOINT_MANAGED_BY_JOB_PROBLEM = "urn:restow:problem:endpoint-config-managed-by-job";

// --- Query keys -------------------------------------------------------------------------

type TenantKey = string | null;

export const backupJobKeys = {
  all: (tenantId: TenantKey) => ["tenant", tenantId, "backup-jobs"] as const,
  lists: (tenantId: TenantKey) => ["tenant", tenantId, "backup-jobs", "list"] as const,
  list: (tenantId: TenantKey, kind: JobKind | undefined) =>
    ["tenant", tenantId, "backup-jobs", "list", kind ?? "all"] as const,
  detail: (tenantId: TenantKey, jobId: string) =>
    ["tenant", tenantId, "backup-jobs", "detail", jobId] as const,
  members: (tenantId: TenantKey, jobId: string) =>
    ["tenant", tenantId, "backup-jobs", "detail", jobId, "members"] as const,
  runs: (tenantId: TenantKey, jobId: string, limit: number) =>
    ["tenant", tenantId, "backup-jobs", "detail", jobId, "runs", limit] as const,
  defaults: (tenantId: TenantKey, kind: JobKind, endpointIds: readonly string[] = []) =>
    ["tenant", tenantId, "backup-jobs", "defaults", kind, ...endpointIds] as const,
  candidates: (tenantId: TenantKey, kind: JobKind, search: string, limit: number) =>
    ["tenant", tenantId, "backup-jobs", "candidates", kind, search, limit] as const,
  recommended: (tenantId: TenantKey, scope: string) =>
    ["tenant", tenantId, "backup-jobs", "recommended", scope] as const,
  machineFolders: (tenantId: TenantKey, endpointIds: readonly string[]) =>
    ["tenant", tenantId, "backup-jobs", "machine-folders", ...endpointIds] as const,
};

// --- Requests --------------------------------------------------------------------------------

const BASE = "/backup-jobs";
const id = encodeURIComponent;

type QueryValue = string | number | null | undefined;

function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

export function fetchBackupJobs(kind?: JobKind): Promise<BackupJobList> {
  return apiFetch<BackupJobList>(`${BASE}${queryString({ kind })}`);
}

export function fetchJobDefaults(
  kind: JobKind,
  endpointIds: readonly string[] = [],
): Promise<JobDefaults> {
  return apiFetch<JobDefaults>(
    `${BASE}/defaults${queryString({ kind, endpointIds: endpointIds.join(",") })}`,
  );
}

export function fetchJobCandidates(
  kind: JobKind,
  search: string,
  limit: number = LIMITS.candidates,
): Promise<JobCandidates> {
  return apiFetch<JobCandidates>(
    `${BASE}/candidates${queryString({ kind, q: search.trim() || undefined, limit })}`,
  );
}

/** The data folders the machines' agents found, and their profiles (#59). */
export function fetchMachineFolders(
  endpointIds: readonly string[],
): Promise<{ items: MachineFolders[] }> {
  return apiFetch<{ items: MachineFolders[] }>(
    `${BASE}/machine-folders${queryString({ endpointIds: endpointIds.join(",") })}`,
  );
}

/** Adds data folders an agent found to a machine job (the server narrows an exclusion in the way). */
export function addDataFolders(jobId: string, folders: readonly string[]): Promise<BackupJob> {
  return apiFetch<BackupJob>(`${BASE}/${id(jobId)}/folders`, {
    method: "POST",
    body: { folders },
  });
}

export function createBackupJob(input: CreateBackupJobInput): Promise<BackupJob> {
  return apiFetch<BackupJob>(BASE, { method: "POST", body: input });
}

export function fetchBackupJob(jobId: string): Promise<BackupJob> {
  return apiFetch<BackupJob>(`${BASE}/${id(jobId)}`);
}

export function updateBackupJob(jobId: string, patch: UpdateBackupJobInput): Promise<BackupJob> {
  return apiFetch<BackupJob>(`${BASE}/${id(jobId)}`, { method: "PATCH", body: patch });
}

export function deleteBackupJob(jobId: string): Promise<void> {
  return apiFetch<void>(`${BASE}/${id(jobId)}`, { method: "DELETE" });
}

export function fetchJobMembers(jobId: string): Promise<JobMembers> {
  return apiFetch<JobMembers>(`${BASE}/${id(jobId)}/members`);
}

/**
 * The writes of the scope answer with the job as it stands afterwards (its counts and its state), not
 * with the members: read the members again for those.
 */

/** Replaces the scope of the job. */
export function replaceJobMembers(jobId: string, input: ReplaceMembersInput): Promise<BackupJob> {
  return apiFetch<BackupJob>(`${BASE}/${id(jobId)}/members`, { method: "PUT", body: input });
}

export function addJobMembers(jobId: string, input: AddMembersInput): Promise<BackupJob> {
  return apiFetch<BackupJob>(`${BASE}/${id(jobId)}/members`, { method: "POST", body: input });
}

/** An empty `overrides` object clears the member's overrides. */
export function setMemberOverrides(
  jobId: string,
  targetId: string,
  overrides: JobMemberOverrides,
): Promise<BackupJob> {
  return apiFetch<BackupJob>(`${BASE}/${id(jobId)}/members/${id(targetId)}`, {
    method: "PATCH",
    body: { overrides },
  });
}

export function removeJobMember(jobId: string, targetId: string): Promise<BackupJob> {
  return apiFetch<BackupJob>(`${BASE}/${id(jobId)}/members/${id(targetId)}`, { method: "DELETE" });
}

export function runBackupJob(
  jobId: string,
  input: RunBackupJobInput = {},
): Promise<RunBackupJobResult> {
  return apiFetch<RunBackupJobResult>(`${BASE}/${id(jobId)}/run`, { method: "POST", body: input });
}

/** What "Stop" of a job did (0.4.5): backups withdrawn before they started, backups asked to stop. */
export interface CancelBackupJobResult {
  withdrawn: number;
  stopping: number;
}

/** "Stop" of a job: every queued or running backup of it (0.4.5). */
export function cancelBackupJob(jobId: string): Promise<CancelBackupJobResult> {
  return apiFetch<CancelBackupJobResult>(`${BASE}/${id(jobId)}/cancel`, {
    method: "POST",
    body: {},
  });
}

export function fetchJobRuns(jobId: string, limit = 30): Promise<JobRuns> {
  return apiFetch<JobRuns>(`${BASE}/${id(jobId)}/runs${queryString({ limit })}`);
}

// --- Recommended jobs (#52) ----------------------------------------------------------------

/** What "Create recommended job" covers: the mail job, machines, guests, or everything without a job. */
export interface RecommendedScope {
  mail?: boolean;
  endpointIds?: readonly string[];
  guestIds?: readonly string[];
  everything?: boolean;
  /** With `everything`: only these kinds (the notice of one list); absent = all. */
  kinds?: readonly RecommendedKind[];
}

export type RecommendedKind = "mail" | "endpoint" | "pve" | "archive";

/** The kinds of mail object an archive captures (packages/db archive-capture.ts). */
export type RecommendedCaptureKind = "m365" | "google" | "imap" | "imap_microsoft";

/** One job the click makes, or adds to (apps/api backup-jobs/recommended.ts). */
export interface RecommendedJobPlan {
  kind: RecommendedKind;
  key: string;
  /** `enable`: switch archiving on in the mail job over all objects (servers from 0.4.7). */
  action: "create" | "add" | "enable";
  jobId: string | null;
  name: string;
  os: string | null;
  profile: "server" | "client" | null;
  /** Null: a job that is switched to archiving and runs by hand keeps doing so. */
  schedule: JobSchedule | null;
  verifySchedule: JobSchedule | null;
  retention: JobRetention | null;
  retentionPolicy: string | null;
  repository: Repository | null;
  mode: "snapshot" | "suspend" | "stop" | null;
  paths: string[];
  members: { id: string; name: string }[];
  memberCount: number;
  /** Mail: the job archives as well, with the default capture ways; missing before 0.4.7. */
  archive?: boolean;
  /** What the archive captures, each kind by its default way. */
  captureKinds?: RecommendedCaptureKind[];
}

export interface RecommendedSkip {
  kind: RecommendedKind;
  id: string;
  name: string | null;
  /** no_capture_way: the job over all objects has a capture way switched off by hand. */
  reason: "in_job" | "unavailable" | "covered" | "no_capture_way";
}

export interface RecommendedPlan {
  items: RecommendedJobPlan[];
  skipped: RecommendedSkip[];
}

export interface RecommendedApplied {
  items: {
    kind: RecommendedKind;
    key: string;
    jobId: string;
    name: string;
    created: boolean;
    added: number;
  }[];
  skipped: RecommendedSkip[];
}

function recommendedBody(scope: RecommendedScope) {
  return {
    mail: scope.mail === true,
    endpointIds: [...(scope.endpointIds ?? [])],
    guestIds: [...(scope.guestIds ?? [])],
    everything: scope.everything === true,
    kinds: [...(scope.kinds ?? [])],
  };
}

export function fetchRecommendedPlan(scope: RecommendedScope): Promise<RecommendedPlan> {
  const body = recommendedBody(scope);
  return apiFetch<RecommendedPlan>(
    `${BASE}/recommended${queryString({
      mail: body.mail ? 1 : undefined,
      endpointIds: body.endpointIds.join(","),
      guestIds: body.guestIds.join(","),
      everything: body.everything ? 1 : undefined,
      kinds: body.kinds.join(","),
    })}`,
  );
}

export function applyRecommendedJobs(scope: RecommendedScope): Promise<RecommendedApplied> {
  return apiFetch<RecommendedApplied>(`${BASE}/recommended`, {
    method: "POST",
    body: recommendedBody(scope),
  });
}
