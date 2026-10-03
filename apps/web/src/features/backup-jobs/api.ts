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

export type JobKind = "mail" | "endpoint";
export const JOB_KINDS: readonly JobKind[] = ["mail", "endpoint"];

export type JobScopeMode = "all" | "selected";
export type JobOrigin = "user" | "migration";

/**
 * How a job stands, worst first: paused (switched off), failing (the last
 * backup of an object failed), running, queued (a machine
 * backup was requested and waits for the machine), attention (a partial backup, a failed
 * or missing restore check, or nothing backed up yet), empty (nothing in
 * scope), ok. `ok` says the backups ran, not that they are restorable.
 */
export type JobState = "paused" | "failing" | "running" | "queued" | "attention" | "empty" | "ok";

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
  /** Upload limit in kbit/s, the default outside every time window; null or absent = unlimited. */
  bandwidthKbps?: number | null;
  /**
   * Time windows with a limit of their own, read in the time zone of the job's schedule; the limit
   * in force when a run starts applies. Absent or empty = none.
   */
  bandwidthWindows?: BandwidthWindow[];
  retention?: JobRetention;
}

/** What one member does differently from the job; a field set here replaces the job's value. */
export type JobMemberOverrides = JobEndpointSettings & {
  schedule?: JobSchedule;
  /** Mail: its own restore-check schedule. */
  verifySchedule?: JobSchedule;
};

// --- Responses (apps/api backup-jobs/dto.ts) ----------------------------------------

export interface Repository {
  /** The storage target; null when the tenant has none of its own (the installation default). */
  id: string | null;
  name: string | null;
  kind: "local" | "s3" | "installation_default";
  role: "primary" | "copy" | "previous" | null;
  status: "unverified" | "ok" | "error" | null;
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
  createdAt: string;
  updatedAt: string;
}

export interface BackupJobList {
  items: BackupJob[];
  /** What no job covers: active mail objects, and machines that are in no job. */
  uncovered: { mail: number; endpoint: number };
}

export type MemberKind = "mailbox" | "onedrive" | "imap" | "server" | "client";
export type MemberRestoreState = "green" | "yellow" | "red" | "unverified" | "no_backup";
export type MemberOutcome = "succeeded" | "partial" | "failed" | "running" | "queued";

export interface JobMember {
  /** The id of the protected object (mail) or the machine. */
  targetId: string;
  kind: MemberKind;
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
  name: string;
  detail: string | null;
  status: string;
  /** The job it belongs to already (an object or machine has at most one). */
  job: { id: string; name: string } | null;
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
  /** The tenant's primary storage target: the only one jobs write to. */
  repository: Repository;
  retentionPolicies: RetentionPolicyChoice[];
  /** Machine jobs: what a machine keeps its repository with unless the job says otherwise. */
  endpointRetention: JobRetention;
}

export interface JobRun {
  id: string;
  /** `mail`: a run of the queue (backup, restore check); `endpoint`: a run an agent reported. */
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
  /** Take objects and machines that belong to another job instead of refusing them. */
  moveMembers?: boolean;
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
  defaults: (tenantId: TenantKey, kind: JobKind) =>
    ["tenant", tenantId, "backup-jobs", "defaults", kind] as const,
  candidates: (tenantId: TenantKey, kind: JobKind, search: string, limit: number) =>
    ["tenant", tenantId, "backup-jobs", "candidates", kind, search, limit] as const,
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

export function fetchJobDefaults(kind: JobKind): Promise<JobDefaults> {
  return apiFetch<JobDefaults>(`${BASE}/defaults${queryString({ kind })}`);
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

export function fetchJobRuns(jobId: string, limit = 30): Promise<JobRuns> {
  return apiFetch<JobRuns>(`${BASE}/${id(jobId)}/runs${queryString({ limit })}`);
}
