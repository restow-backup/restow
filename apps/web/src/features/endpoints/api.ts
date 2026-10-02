import type { BandwidthWindow } from "@/features/backup-jobs/bandwidth-windows";
import type { Failure } from "@/features/failures";
import { apiFetch } from "@/lib/api";

import type { EndpointProfile } from "./paths.js";

/**
 * Typed client for /api/v1/endpoints (apps/api/src/features/endpoints: dto.ts
 * for the responses, schemas.ts for the requests and their limits). The shapes
 * mirror the API one to one. Query keys carry the tenant so a tenant switch
 * never shows another tenant's machines.
 */

export type { EndpointProfile };

export type EndpointOs = "linux" | "windows" | "darwin";
/** The systems the enrollment offers; Windows is planned, the API refuses it. */
export type EnrollOs = Exclude<EndpointOs, "windows">;
export type EndpointArch = "amd64" | "arm64";
export type EndpointStatus = "active" | "revoked";
export type Connection = "online" | "offline" | "never";
export type AgentState = "idle" | "running";

/** Rating of the newest backup: a restore test (or a repository check) decides it. */
export type ReadinessState = "green" | "yellow" | "red" | "unverified" | "no_backup";
export type ReadinessRating = "green" | "yellow" | "red";

/** Why a machine needs attention; the web app words them. */
export type Attention =
  | "silent"
  | "backup_overdue"
  | "last_backup_failed"
  | "restore_test_failed"
  | "repository_damaged"
  | "never_seen";

export interface EndpointReadiness {
  state: ReadinessState;
  checkedAt: string | null;
  overdue: boolean;
  basis: "restore_test" | "repository_check" | null;
  latestSnapshotId: string | null;
}

export type RunKind = "backup" | "restore" | "verify_sample";
export type RunStatus = "running" | "succeeded" | "partial" | "failed";

export interface RunProgress {
  filesDone: number;
  bytesDone: number;
  totalFiles?: number;
  totalBytes?: number;
  currentPath?: string;
  updatedAt: string;
}

export interface RunSummary {
  id: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  snapshotId: string | null;
  errorCount: number;
  /** The agent was restarted during the run and carries on by itself: not a failed backup. */
  interruptedOnly: boolean;
  /**
   * A restore test on the machine that could not complete: it rated nothing,
   * proves nothing about the backup and is offered again. Never shown as failed.
   */
  checkIncomplete: boolean;
  /** Why the run did not end well, explained by the server; null for a good run. */
  failure: Failure | null;
  filesNew: number | null;
  dataAdded: number | null;
  totalBytesProcessed: number | null;
  progress: RunProgress | null;
}

export interface EndpointSummary {
  id: string;
  hostname: string;
  displayName: string | null;
  os: EndpointOs;
  arch: EndpointArch;
  profile: EndpointProfile;
  agentVersion: string | null;
  osVersion: string | null;
  status: EndpointStatus;
  connection: Connection;
  agentState: AgentState | null;
  lastSeenAt: string | null;
  lastBackupAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  readiness: EndpointReadiness;
  latestRun: RunSummary | null;
  attention: Attention[];
  /**
   * The backup job the machine belongs to (release 0.2.0); null when it is in none and keeps the
   * configuration it has. While it is in a job the job owns its configuration (`config`): schedule,
   * folders, exclusions, hooks and bandwidth. Absent on servers from before 0.2.0, which read as null.
   */
  job?: { id: string; name: string } | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface RunError {
  path?: string;
  message: string;
  code?: string;
}

export interface RunStats {
  filesNew?: number;
  filesChanged?: number;
  filesUnmodified?: number;
  dataAdded?: number;
  totalFilesProcessed?: number;
  totalBytesProcessed?: number;
}

export interface RunDetail extends RunSummary {
  taskId: string | null;
  errors: RunError[];
  logTail: string | null;
  stats: RunStats | null;
}

export type TaskKind = "backup_now" | "restore" | "verify_sample" | "update_config" | "uninstall";
export type TaskStatus = "pending" | "delivered" | "done" | "failed";

export interface EndpointTask {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  params: Record<string, unknown>;
  createdAt: string;
  deliveredAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  /** A restore-test request that ended without a rating (expired, revoked, could not complete). */
  checkIncomplete: boolean;
}

export type ReportKind = "restore_test" | "repository_check" | "retention";

export interface ReportMismatch {
  path: string;
  expected: string;
  actual: string | null;
  reason?: string;
}

export interface ReportData {
  files?: number;
  matched?: number;
  mismatched?: ReportMismatch[];
  subsetPercent?: number;
  removedSnapshots?: number;
  keptSnapshots?: number;
  repositoryBytes?: number;
  /** Snapshots retention left alone because no backup run reported them. */
  unrecordedSnapshots?: number;
  /** Snapshots dated in the future or after their file was stored. */
  futureSnapshots?: number;
  errorMessage?: string;
  [key: string]: unknown;
}

export interface EndpointReport {
  id: string;
  kind: ReportKind;
  origin: "server" | "agent";
  snapshotId: string | null;
  readiness: ReadinessRating | null;
  summary: ReportData;
  checkedAt: string;
}

export type ScheduleKind = "interval" | "daily" | "on_connect";

/** When the agent backs up (the agent contract, docs/AGENT.md). */
export interface EndpointSchedule {
  kind: ScheduleKind;
  /** `interval`: minutes between backups; `on_connect`: the least minutes between two backups. */
  intervalMinutes?: number;
  /** `daily`: local time `HH:MM`. */
  timeOfDay?: string;
  /** IANA zone `timeOfDay` is read in. */
  timeZone: string;
}

export interface EndpointConfig {
  profile: EndpointProfile;
  schedule: EndpointSchedule;
  paths: string[];
  excludes: string[];
  hooks: { pre?: string; post?: string };
  bandwidthKbps: number | null;
  /**
   * Time windows with a limit of their own, read in the zone of `schedule`; absent when there are none.
   * `bandwidthKbps` is the limit outside every window.
   */
  bandwidthWindows?: BandwidthWindow[];
  onlyOnAcPower: boolean;
  useVss: boolean;
}

export interface Retention {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export interface EffectiveSettings {
  retention: Retention;
  staleAfterHours: number;
  staleAfterDays: number;
  /** The machine's own storage budget in GiB; null when the installation's default applies. */
  quotaGib: number | null;
}

export type QuotaLevel = "ok" | "near" | "exceeded";

/** What the repository takes in the storage and what it may take (docs/AGENT.md). */
export interface EndpointStorage {
  /** Bytes the repository takes; null until it was first measured. */
  usedBytes: number | null;
  measuredAt: string | null;
  /** The budget of this machine in bytes; null when there is none. */
  budgetBytes: number | null;
  /** The machine has a budget of its own (else the installation's default applies). */
  ownBudget: boolean;
  defaultBudgetBytes: number | null;
  /** All servers and clients of the tenant together, and their common budget. */
  tenantUsedBytes: number;
  tenantBudgetBytes: number | null;
  level: QuotaLevel;
  /** The last upload refused because a budget was used up. */
  refusedAt: string | null;
}

/** One reason a machine needs attention, explained (`attention` names them). */
export interface EndpointProblem {
  attention: Attention;
  failure: Failure;
}

export interface EndpointDetail extends EndpointSummary {
  config: EndpointConfig;
  configVersion: number;
  /** The configuration version the agent runs; differs from `configVersion` until it fetched the change. */
  agentConfigVersion: number | null;
  settings: EffectiveSettings;
  /** What needs attention, each with its explanation and what to do. */
  problems: EndpointProblem[];
  runs: RunSummary[];
  /** Requests that still wait for the machine: queued, or handed over and not finished. */
  tasks: EndpointTask[];
  /** The last finished requests (done or failed), newest first. */
  recentTasks: EndpointTask[];
  reports: EndpointReport[];
  /** What the last retention run found; null before the first one. */
  repository: { bytes: number | null; snapshots: number | null; at: string } | null;
  /** Storage use and budget of the repository. */
  storage: EndpointStorage;
  lastRetentionAt: string | null;
  lastCheckAt: string | null;
  lastRestoreTestAt: string | null;
  /** Commands for the machine (null for systems without an install script). */
  commands: {
    uninstallScript: string;
    uninstallAgent: string;
    /** What an administrator of the machine runs to allow hooks from the server. */
    hooksScripts: string;
    hooksAny: string;
  } | null;
  /** Hooks: what the machine allows and what is configured. */
  hooks: EndpointHooks;
  /** No new agent release is installed on this machine: the tenant paused updates, or the machine is paused on its own. */
  autoUpdatePaused: boolean;
  /** The machine is paused on its own (an override that outlives the tenant's setting). */
  autoUpdateOwnPause: boolean;
}

/**
 * The machine's own rule for hooks (set by root on the machine, never in
 * Restow): off, only named scripts from /etc/restow-agent/hooks.d, or any
 * command. null: the agent has not reported it yet.
 */
export type HookPolicy = "off" | "scripts" | "any";

export interface HookSummary {
  set: boolean;
  /** The first 16 hex digits of the SHA-256 of the hook text (as in the audit log). */
  fingerprint: string | null;
}

export interface EndpointHooks {
  policy: HookPolicy | null;
  /** The scripts the machine offers (policy `scripts`). */
  scripts: string[];
  /** Whether `config.hooks` carries the texts: only for who may change the configuration. */
  visible: boolean;
  pre: HookSummary;
  post: HookSummary;
}

/** A machine that is paused on its own, as the Agents section lists it. */
export interface AgentUpdateOverride {
  id: string;
  name: string;
  profile: "server" | "client";
}

/** The tenant's setting for automatic agent updates, and the machines paused on their own. */
export interface AgentUpdates {
  /** One setting for the whole tenant; it also covers machines that enrol later. */
  paused: boolean;
  /** Machines of the tenant. */
  endpoints: number;
  /** Machines paused on their own: they stay paused whatever the tenant says. */
  overrides: AgentUpdateOverride[];
}

/** What the scripts policy accepts as a hook: the plain name of a script. */
export const HOOK_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type TokenState = "valid" | "expired" | "used" | "revoked";

/** Which tokens a listing asks for: the valid ones, or every state. */
export type TokenListState = "valid" | "all";

export interface EnrollmentToken {
  id: string;
  profile: EndpointProfile;
  displayName: string | null;
  createdAt: string;
  expiresAt: string;
  state: TokenState;
  usedByEndpointId: string | null;
}

export type TokenWarning = "insecure_transport" | "instance_url_not_configured";

/**
 * The answer to creating a token. The token is shown once, next to the
 * command: the install script asks for it (hidden input), so it is in no
 * command, process list or shell history. `installUnattended` reads it from a
 * root-only file instead.
 */
export interface CreatedToken extends EnrollmentToken {
  token: string;
  os: EnrollOs;
  instanceUrl: string;
  commands: {
    install: string;
    installUnattended: string;
    /** Where `installUnattended` expects the token. */
    tokenFile: string;
    uninstallScript: string;
    uninstallAgent: string;
    hooksScripts: string;
    hooksAny: string;
  };
  warnings: TokenWarning[];
}

export type VerificationState = "green" | "red" | "unverified";

export interface EndpointSnapshot {
  /** The full restic snapshot id; a restore names it in full. */
  id: string;
  shortId: string;
  time: string;
  hostname: string;
  paths: string[];
  filesNew: number | null;
  totalFilesProcessed: number | null;
  totalBytesProcessed: number | null;
  /** The rating of exactly this snapshot (restore tests). */
  verification: { state: VerificationState; checkedAt: string | null };
  /** Why retention found this snapshot suspicious; empty for a normal one. */
  flags: SnapshotFlag[];
}

/** No backup run reported the snapshot, or it is dated in the future. */
export type SnapshotFlag = "unrecorded" | "future_time";

export type BrowseEntryType = "file" | "dir" | "symlink" | "other";

export interface BrowseEntry {
  name: string;
  path: string;
  type: BrowseEntryType;
  size: number | null;
  mtime: string | null;
}

/** One page of a folder, in the order the server lists it: folders first, then by name. */
export interface BrowseResult {
  snapshotId: string;
  path: string;
  entries: BrowseEntry[];
  /** Pass it to fetch the next page; null when the folder has no more entries. */
  nextCursor: string | null;
}

/** A ZIP that was checked against the snapshot and waits to be started. */
export interface PreparedDownload {
  id: string;
  /** After this time the download can no longer be started; prepare it again. */
  expiresAt: string;
  /** Files and folders the ZIP will hold. */
  items: number;
}

// --- Request bodies (schemas.ts) ------------------------------------------------

export interface CreateTokenInput {
  profile: EndpointProfile;
  os: EnrollOs;
  displayName?: string;
}

export interface UpdateEndpointInput {
  /** `null` clears the name; the host name is shown again. */
  displayName?: string | null;
  config?: {
    schedule?: EndpointSchedule;
    paths?: string[];
    excludes?: string[];
    hooks?: { pre?: string; post?: string };
    bandwidthKbps?: number | null;
    /** `null` or an empty list removes them. */
    bandwidthWindows?: BandwidthWindow[] | null;
    onlyOnAcPower?: boolean;
  };
  settings?: {
    retention?: Retention;
    staleAfterHours?: number;
    staleAfterDays?: number;
    /** GiB; `null` returns to the installation's default. */
    quotaGib?: number | null;
  };
}

export type CreateTaskInput =
  | { kind: "backup_now" }
  | { kind: "restore"; snapshotId: string; paths: string[]; targetDir?: string };

export interface TaskResult {
  task: EndpointTask;
  alreadyQueued: boolean;
}

/**
 * The problem type of a change to the configuration of a machine that is in a backup job: the job owns it
 * (409). The settings page shows those fields read-only, so this is only the answer to a stale page.
 */
export const CONFIG_MANAGED_BY_JOB_PROBLEM = "urn:restow:problem:endpoint-config-managed-by-job";

/** The API's limits (schemas.ts), so the UI stops before the request is refused. */
export const LIMITS = {
  /** Paths in one ZIP download (they travel in the body of the request). */
  downloadPaths: 10_000,
  /** Entries one page of a folder holds; "Load more" fetches the next page. */
  browsePage: 1000,
  /** Paths in one restore task. */
  restorePaths: 200,
  /** Backup paths of an endpoint. */
  backupPaths: 200,
  /** Exclude patterns of an endpoint. */
  excludes: 500,
  displayName: 200,
  pathLength: 1024,
  excludeLength: 512,
  hookLength: 4096,
  bandwidthMaxKbps: 10_000_000,
  intervalMinMinutes: 5,
  intervalMaxMinutes: 7 * 24 * 60,
  keepDaily: 3650,
  keepWeekly: 520,
  keepMonthly: 240,
  staleHoursMax: 24 * 30,
  staleDaysMax: 365,
  /** The largest storage budget of one machine, in GiB (1 PiB). */
  quotaGibMax: 1024 * 1024,
  /** Runs the endpoint page can list (the detail carries the newest 20). */
  runs: 100,
} as const;

// --- Query keys -------------------------------------------------------------------

type TenantKey = string | null;

export const endpointKeys = {
  all: (tenantId: TenantKey) => ["tenant", tenantId, "endpoints"] as const,
  lists: (tenantId: TenantKey) => ["tenant", tenantId, "endpoints", "list"] as const,
  list: (tenantId: TenantKey, profile: EndpointProfile | undefined) =>
    ["tenant", tenantId, "endpoints", "list", profile ?? "all"] as const,
  detail: (tenantId: TenantKey, endpointId: string) =>
    ["tenant", tenantId, "endpoints", "detail", endpointId] as const,
  runs: (tenantId: TenantKey, endpointId: string, limit: number) =>
    ["tenant", tenantId, "endpoints", "detail", endpointId, "runs", limit] as const,
  run: (tenantId: TenantKey, endpointId: string, runId: string) =>
    ["tenant", tenantId, "endpoints", "detail", endpointId, "run", runId] as const,
  snapshots: (tenantId: TenantKey, endpointId: string) =>
    ["tenant", tenantId, "endpoints", "snapshots", endpointId] as const,
  browse: (tenantId: TenantKey, endpointId: string, snapshotId: string, path: string) =>
    ["tenant", tenantId, "endpoints", "browse", endpointId, snapshotId, path] as const,
  /** Every token listing of the tenant (the prefix the mutations invalidate). */
  tokensAll: (tenantId: TenantKey) => ["tenant", tenantId, "endpoints", "tokens"] as const,
  tokens: (tenantId: TenantKey, state: TokenListState) =>
    ["tenant", tenantId, "endpoints", "tokens", state] as const,
  agentUpdates: (tenantId: TenantKey) =>
    ["tenant", tenantId, "endpoints", "agent-updates"] as const,
};

// --- Requests ---------------------------------------------------------------------

const BASE = "/endpoints";
const id = encodeURIComponent;

type QueryValue = string | number | null | undefined;

function queryString(params: Record<string, QueryValue | readonly string[]>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "object" && value !== null) {
      for (const item of value) {
        search.append(key, item);
      }
    } else if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

export async function fetchEndpoints(profile?: EndpointProfile): Promise<EndpointSummary[]> {
  const body = await apiFetch<{ items: EndpointSummary[] }>(`${BASE}${queryString({ profile })}`);
  return body.items;
}

export function fetchEndpoint(endpointId: string): Promise<EndpointDetail> {
  return apiFetch<EndpointDetail>(`${BASE}/${id(endpointId)}`);
}

export function updateEndpoint(
  endpointId: string,
  input: UpdateEndpointInput,
): Promise<{ configVersion: number; changed: string[] }> {
  return apiFetch(`${BASE}/${id(endpointId)}`, { method: "PATCH", body: input });
}

export function revokeEndpoint(endpointId: string): Promise<void> {
  return apiFetch<void>(`${BASE}/${id(endpointId)}/revoke`, { method: "POST" });
}

export function uninstallEndpoint(endpointId: string): Promise<TaskResult> {
  return apiFetch<TaskResult>(`${BASE}/${id(endpointId)}/uninstall`, { method: "POST" });
}

export function createTask(endpointId: string, input: CreateTaskInput): Promise<TaskResult> {
  return apiFetch<TaskResult>(`${BASE}/${id(endpointId)}/tasks`, { method: "POST", body: input });
}

export function requestRestoreTest(endpointId: string): Promise<{ queued: boolean }> {
  return apiFetch(`${BASE}/${id(endpointId)}/restore-test`, { method: "POST" });
}

/** The restic password of the machine's repository, in clear; audited by the server. */
export interface RepositoryKey {
  password: string;
  /** Where the repository lies below the storage target, e.g. `endpoints/<id>`. */
  storagePrefix: string;
}

/**
 * For a restore without Restow. The answer is a secret: keep it in memory
 * only (a mutation that is not cached), never in a URL or in storage.
 */
export function revealRepositoryPassword(endpointId: string): Promise<RepositoryKey> {
  return apiFetch<RepositoryKey>(`${BASE}/${id(endpointId)}/repository-password`, {
    method: "POST",
  });
}

export async function fetchRuns(endpointId: string, limit: number): Promise<RunSummary[]> {
  const body = await apiFetch<{ items: RunSummary[] }>(
    `${BASE}/${id(endpointId)}/runs${queryString({ limit })}`,
  );
  return body.items;
}

export function fetchRun(endpointId: string, runId: string): Promise<RunDetail> {
  return apiFetch<RunDetail>(`${BASE}/${id(endpointId)}/runs/${id(runId)}`);
}

export async function fetchSnapshots(endpointId: string): Promise<EndpointSnapshot[]> {
  const body = await apiFetch<{ items: EndpointSnapshot[] }>(`${BASE}/${id(endpointId)}/snapshots`);
  return body.items;
}

/** One page of a folder of a snapshot; every call is audited by the server. */
export function fetchBrowse(
  endpointId: string,
  snapshotId: string,
  path: string,
  cursor?: string | null,
): Promise<BrowseResult> {
  return apiFetch<BrowseResult>(
    `${BASE}/${id(endpointId)}/browse${queryString({
      snapshotId,
      path,
      limit: LIMITS.browsePage,
      cursor,
    })}`,
  );
}

/** The valid tokens by default; `all` adds used, expired and revoked ones. */
export async function fetchTokens(state: TokenListState = "valid"): Promise<EnrollmentToken[]> {
  const body = await apiFetch<{ items: EnrollmentToken[] }>(
    `${BASE}/tokens${queryString({ state: state === "all" ? "all" : undefined })}`,
  );
  return body.items;
}

/** The answer carries the token in clear, once: keep it in memory only, never in a URL or storage. */
export function createToken(input: CreateTokenInput): Promise<CreatedToken> {
  return apiFetch<CreatedToken>(`${BASE}/tokens`, { method: "POST", body: input });
}

export function fetchAgentUpdates(): Promise<AgentUpdates> {
  return apiFetch<AgentUpdates>(`${BASE}/agent-updates`);
}

/** `resumeMachines` also lifts the machines' own pauses. */
export function setAgentUpdates(paused: boolean, resumeMachines = false): Promise<AgentUpdates> {
  return apiFetch<AgentUpdates>(`${BASE}/agent-updates`, {
    method: "PUT",
    body: resumeMachines ? { paused, resumeMachines } : { paused },
  });
}

/** Lift the own pause of one machine; it then follows the tenant's setting. */
export function resumeMachineUpdates(endpointId: string): Promise<AgentUpdates> {
  return apiFetch<AgentUpdates>(`${BASE}/agent-updates/machines/${id(endpointId)}`, {
    method: "DELETE",
  });
}

export function revokeToken(tokenId: string): Promise<void> {
  return apiFetch<void>(`${BASE}/tokens/${id(tokenId)}`, { method: "DELETE" });
}

const rawBaseUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_BASE_URL = (rawBaseUrl ?? "/api/v1").replace(/\/+$/, "");

/**
 * Step one of a ZIP download: the server checks the selected paths (they
 * travel in the body, so a selection can be large) and answers with a
 * short-lived download that can be started once.
 */
export function createDownload(
  endpointId: string,
  snapshotId: string,
  paths: readonly string[],
): Promise<PreparedDownload> {
  return apiFetch<PreparedDownload>(`${BASE}/${id(endpointId)}/downloads`, {
    method: "POST",
    body: { snapshotId, paths },
  });
}

/**
 * Step two: the address of a prepared download. Starting it is a plain browser
 * navigation (the cookie authenticates, the archive streams to disk), which
 * cannot carry the tenant header, so the tenant travels as the `tenant` query
 * parameter, which the API accepts for this route only.
 */
export function endpointDownloadUrl(
  endpointId: string,
  downloadId: string,
  tenantId: string | null,
): string {
  return `${API_BASE_URL}${BASE}/${id(endpointId)}/downloads/${id(downloadId)}${queryString({
    tenant: tenantId,
  })}`;
}
