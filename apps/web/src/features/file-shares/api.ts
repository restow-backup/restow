import { apiFetch } from "@/lib/api";

import type { BrowseEntry } from "@/features/endpoints/api";
import type { Failure } from "@/features/failures/api";

/**
 * Typed client of /api/v1/file-shares (apps/api/src/features/file-shares: dto.ts for the
 * answers, schemas.ts for the requests). The shapes mirror the API one to one; times are ISO
 * 8601 in UTC. Never a password: `hasPassword` says whether one is stored.
 */

export type ShareProtocol = "smb" | "nfs";
export type SmbVersion = "3.1.1" | "3.0" | "2.1";
export type NfsVersion = "3" | "4" | "4.1" | "4.2";
export const SMB_VERSIONS: readonly SmbVersion[] = ["3.1.1", "3.0", "2.1"];
export const NFS_VERSIONS: readonly NfsVersion[] = ["4.1", "4.2", "4", "3"];

export type ShareStanding =
  | "retired"
  | "failed"
  | "running"
  | "overdue"
  | "warning"
  | "no_job"
  | "no_backup"
  | "ok";
export type ShareReadinessState = "green" | "yellow" | "red" | "unverified" | "no_backup";
export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "warning"
  | "failed"
  | "cancelled";
export type RunKind = "backup" | "restore";
export type RunTrigger = "schedule" | "manual" | "retry" | "copy";

export interface RunProgress {
  phase: string;
  filesDone: number;
  bytesDone: number;
  totalFiles: number;
  totalBytes: number;
  currentPath: string;
  bytesUploaded: number;
  at: string;
}

export interface PrivateNetworkApproval {
  by: string;
  at: string;
  address: string;
  range: string;
}

export interface LastTest {
  ok: boolean;
  code: string | null;
  at: string;
  durationMs: number;
}

export interface ShareRunBrief {
  id: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: string | null;
  queuedAt: string | null;
  finishedAt: string | null;
  progress: RunProgress | null;
}

export interface FileShareSummary {
  id: string;
  name: string;
  protocol: ShareProtocol;
  server: string;
  location: string;
  shareName: string | null;
  exportPath: string | null;
  subfolder: string;
  smbVersion: SmbVersion | null;
  seal: boolean;
  nfsVersion: NfsVersion | null;
  username: string | null;
  domain: string | null;
  hasPassword: boolean;
  allowRestore: boolean;
  permissionsMode: "auto" | "off";
  rereadPermissions: boolean;
  retiredAt: string | null;
  createdAt: string;
  privateNetworkApproval: PrivateNetworkApproval | null;
  lastTest: LastTest | null;
  credentialFailedAt: string | null;
  job: { id: string; name: string; enabled: boolean } | null;
  includes: string[];
  protected: boolean;
  standing: ShareStanding;
  readiness: { state: ShareReadinessState; checkedAt: string | null; overdue: boolean };
  lastRun: {
    id: string;
    status: string;
    finishedAt: string | null;
    failure: Failure | null;
  } | null;
  activeRun: ShareRunBrief | null;
  lastBackupAt: string | null;
  lastSuccessAt: string | null;
  restorePoints: number;
  repository: { readyAt: string | null; bytes: number | null };
  quotaGib: number | null;
  catalog: { at: string | null };
}

export interface ShareCounts {
  total: number;
  protected: number;
  withoutJob: number;
  failed: number;
  warnings: number;
  lastSuccessAt: string | null;
}

export interface FileShareList {
  items: FileShareSummary[];
  counts: ShareCounts;
}

export interface ShareRun {
  id: string;
  kind: RunKind;
  status: RunStatus;
  trigger: RunTrigger;
  backupJobId: string | null;
  fileShareId: string;
  targetShareId: string | null;
  sourceSnapshotId: string | null;
  params: {
    paths?: string[];
    pathCount?: number;
    destination?: "original" | "new_folder" | "folder";
    folder?: string;
    conflict?: "overwrite" | "keep_both" | "skip";
    restorePermissions?: boolean;
    verify?: boolean;
    mode?: "overwrite" | "mirror";
    targetFolder?: string;
    force?: boolean;
    allowEmptyOnce?: boolean;
    includes?: string[];
    note?: string;
  };
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastProgressAt: string | null;
  progress: RunProgress | null;
  stats: {
    files?: number;
    dirs?: number;
    bytes?: number;
    dataAdded?: number;
    items?: Record<string, number>;
    restore?: Record<string, unknown>;
    upToDate?: boolean;
    [key: string]: unknown;
  };
  itemCount: number;
  failure: Failure | null;
  errorMessage: string | null;
  cancelRequestedAt: string | null;
  snapshotId: string | null;
}

export interface ShareRunItem {
  path: string;
  code: string;
  phase: string;
  message: string;
}

export interface ShareRunDetail extends ShareRun {
  logTail: string | null;
  itemsStored: number;
  itemCounts: Record<string, number>;
  items: ShareRunItem[];
  samples: { at: string; bytesDone: number; filesDone: number }[];
}

export interface ShareCopyJob {
  id: string;
  name: string;
  enabled: boolean;
  role: "source" | "target";
  mode: "overwrite" | "mirror";
  targetFolder: string;
  sourceShareId: string;
  targetShareId: string;
}

export interface ShareQuota {
  usedBytes: number | null;
  quotaGib: number | null;
  tenantQuotaGib: number | null;
  tenantUsedBytes: number;
  percent: number | null;
  level: "ok" | "near" | "exceeded";
  refusedAt: string | null;
}

export interface FileShareDetail extends FileShareSummary {
  runs: ShareRun[];
  copyJobs: ShareCopyJob[];
  quota: ShareQuota;
}

export interface ShareListEntry {
  name: string;
  type: "dir" | "file" | "symlink" | "other";
  size: number;
  mtime: string;
  invalidName?: boolean;
}

export interface ShareTestResult {
  ok: boolean;
  code: string | null;
  cause: string | null;
  /** The classified cause with its steps; null on success. */
  failure: Failure | null;
  params: Record<string, unknown>;
  detail: string | null;
  fsType: string | null;
  entries: ShareListEntry[];
  truncated: boolean;
  permissions: { readable: boolean; xattr: string } | null;
  durationMs: number;
  address: string | null;
  testedAt: string;
}

export interface ShareSource {
  ok: boolean;
  path: string;
  entries: ShareListEntry[];
  truncated: boolean;
  cause: string | null;
  failure: Failure | null;
  params: Record<string, unknown>;
  detail: string | null;
}

export interface RunnerState {
  available: boolean;
  ready: boolean;
  blockers: { code: string; detail: string }[];
  running: number;
  limit: number | null;
}

export interface TenantShareSettings {
  runner: RunnerState;
  enableCommand: string;
  tenantsMayUsePrivateNetworks: boolean;
  maxRunHours: number;
  catalogEnabled: boolean;
  tenantQuotaGib: number | null;
  defaultShareQuotaGib: number | null;
}

export interface InstallationShareSettingsValues {
  maxConcurrentRunners: number;
  runnerMemoryMiB: number;
  goMemLimitPercent: number;
  maxRunHours: number;
  defaultReadConcurrency: number;
  tenantsMayUsePrivateNetworks: boolean;
  defaultShareQuotaGib: number;
  tenantShareQuotaGib: number;
  tenantShareQuotaGibByTenant: Record<string, number>;
  catalog: { enabled: boolean; maxEntriesPerShare: number };
}

export interface InstallationShareSettings {
  settings: InstallationShareSettingsValues;
  runner: RunnerState;
  enableCommand: string;
}

export interface ShareSnapshot {
  id: string;
  sequence: number;
  resticSnapshotId: string;
  shortId: string;
  time: string;
  files: number;
  dirs: number;
  bytes: number;
  bytesAdded: number;
  includes: string[];
  permissions: {
    mode: string;
    xattr: string;
    entries: number;
    descriptors: number;
    errors: number;
  } | null;
  verification: { state: "green" | "yellow" | "red" | "unverified"; checkedAt: string | null };
  cataloged: boolean;
}

export interface ShareBrowseResult {
  snapshotId: string;
  path: string;
  entries: BrowseEntry[];
  nextCursor: string | null;
  permissions: ShareSnapshot["permissions"];
}

export interface ShareSearchHit {
  path: string;
  name: string;
  size: number;
  mtime: string | null;
  snapshotId: string | null;
  snapshotTime: string | null;
  current: boolean;
}

export interface ShareVersion {
  size: number;
  mtime: string | null;
  firstSequence: number;
  endSequence: number | null;
  snapshotId: string | null;
  snapshotTime: string | null;
  since: string | null;
  current: boolean;
}

export interface RestoreTarget {
  id: string;
  name: string;
  protocol: ShareProtocol;
  location: string;
}

// --- Requests ------------------------------------------------------------------------

export type ConnectionInput =
  | {
      protocol: "smb";
      server: string;
      share: string;
      subfolder: string;
      account: string;
      domain?: string | null;
      password: string;
      smbVersion: SmbVersion;
      seal: boolean;
    }
  | {
      protocol: "nfs";
      server: string;
      export: string;
      subfolder: string;
      nfsVersion: NfsVersion;
    };

export type CreateShareInput = ConnectionInput & {
  name: string;
  allowRestore: boolean;
  permissionsMode: "auto" | "off";
  rereadPermissions?: boolean;
};

export interface UpdateShareInput {
  name?: string;
  server?: string;
  share?: string;
  export?: string;
  subfolder?: string;
  account?: string;
  domain?: string | null;
  password?: string;
  smbVersion?: SmbVersion;
  seal?: boolean;
  nfsVersion?: NfsVersion;
  allowRestore?: boolean;
  permissionsMode?: "auto" | "off";
  rereadPermissions?: boolean;
  confirmNewLocation?: boolean;
}

export type RestoreDestination = "original" | "new_folder" | "other_share";
export type ConflictMode = "overwrite" | "keep_both" | "skip";

export interface RestoreInput {
  snapshotId: string;
  paths: string[];
  destination: RestoreDestination;
  targetShareId?: string;
  folder?: string;
  conflict?: ConflictMode;
  restorePermissions?: boolean;
  verify?: boolean;
}

/** The API's limits (schemas.ts), so the UI stops before a request is refused. */
export const LIMITS = {
  name: 120,
  /** Paths in one download or restore. */
  selectionPaths: 1000,
  searchMin: 2,
  quotaGibMax: 1024 * 1024,
} as const;

export const FILE_SHARE_PROBLEMS = {
  nameTaken: "urn:restow:problem:file-share-name-taken",
  hostNotAllowed: "urn:restow:problem:file-share-host-not-allowed",
  restoreNotAllowed: "urn:restow:problem:file-share-restore-not-allowed",
  busy: "urn:restow:problem:file-share-busy",
  mounterUnavailable: "urn:restow:problem:file-share-mounter-unavailable",
  locationChange: "urn:restow:problem:file-share-location-change",
  confirmName: "urn:restow:problem:file-share-confirm-name",
  retired: "urn:restow:problem:file-share-retired",
  catalogUnavailable: "urn:restow:problem:file-share-catalog-unavailable",
  repositoryUnavailable: "urn:restow:problem:file-share-repository-unavailable",
  downloadGone: "urn:restow:problem:file-share-download-gone",
  pathNotFound: "urn:restow:problem:file-share-path-not-found",
  providerOnly: "urn:restow:problem:file-share-provider-only",
} as const;

// --- Query keys ------------------------------------------------------------------------

type TenantKey = string | null;

export const fileShareKeys = {
  all: (tenantId: TenantKey) => ["tenant", tenantId, "file-shares"] as const,
  list: (tenantId: TenantKey) => ["tenant", tenantId, "file-shares", "list"] as const,
  settings: (tenantId: TenantKey) => ["tenant", tenantId, "file-shares", "settings"] as const,
  targets: (tenantId: TenantKey) => ["tenant", tenantId, "file-shares", "targets"] as const,
  detail: (tenantId: TenantKey, id: string) =>
    ["tenant", tenantId, "file-shares", "detail", id] as const,
  runs: (tenantId: TenantKey, id: string) =>
    ["tenant", tenantId, "file-shares", "detail", id, "runs"] as const,
  run: (tenantId: TenantKey, id: string, runId: string, code: string) =>
    ["tenant", tenantId, "file-shares", "detail", id, "run", runId, code] as const,
  snapshots: (tenantId: TenantKey, id: string) =>
    ["tenant", tenantId, "file-shares", "detail", id, "snapshots"] as const,
  browse: (tenantId: TenantKey, id: string, snapshotId: string, path: string) =>
    ["tenant", tenantId, "file-shares", "detail", id, "browse", snapshotId, path] as const,
  source: (tenantId: TenantKey, id: string, path: string) =>
    ["tenant", tenantId, "file-shares", "detail", id, "source", path] as const,
  search: (tenantId: TenantKey, id: string, q: string) =>
    ["tenant", tenantId, "file-shares", "detail", id, "search", q] as const,
  versions: (tenantId: TenantKey, id: string, path: string) =>
    ["tenant", tenantId, "file-shares", "detail", id, "versions", path] as const,
  installation: () => ["installation", "file-shares"] as const,
};

// --- Requests --------------------------------------------------------------------------

const BASE = "/file-shares";
const rawBaseUrl = import.meta.env.VITE_API_URL as string | undefined;
/** Where the API answers (as lib/api.ts): a prepared download is a navigation, not a fetch. */
const API_BASE_URL = (rawBaseUrl ?? "/api/v1").replace(/\/+$/, "");
const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function fetchShares(): Promise<FileShareList> {
  return apiFetch<FileShareList>(`${BASE}${query({ retired: "include" })}`);
}

export function fetchShareSettings(): Promise<TenantShareSettings> {
  return apiFetch<TenantShareSettings>(`${BASE}/settings`);
}

export function fetchRestoreTargets(): Promise<{ items: RestoreTarget[] }> {
  return apiFetch<{ items: RestoreTarget[] }>(`${BASE}/restore-targets`);
}

export function testConnection(input: ConnectionInput): Promise<ShareTestResult> {
  return apiFetch<ShareTestResult>(`${BASE}/test`, { method: "POST", body: input });
}

export function createShare(input: CreateShareInput): Promise<FileShareDetail> {
  return apiFetch<FileShareDetail>(BASE, { method: "POST", body: input });
}

export function fetchShare(id: string): Promise<FileShareDetail> {
  return apiFetch<FileShareDetail>(`${BASE}/${enc(id)}`);
}

export function updateShare(id: string, patch: UpdateShareInput): Promise<FileShareDetail> {
  return apiFetch<FileShareDetail>(`${BASE}/${enc(id)}`, { method: "PATCH", body: patch });
}

export function testStoredShare(id: string): Promise<ShareTestResult> {
  return apiFetch<ShareTestResult>(`${BASE}/${enc(id)}/test`, { method: "POST" });
}

export function fetchShareSource(id: string, path: string): Promise<ShareSource> {
  return apiFetch<ShareSource>(`${BASE}/${enc(id)}/source${query({ path })}`);
}

export function backupNow(
  id: string,
  allowEmptyOnce = false,
): Promise<{ run: ShareRun; alreadyQueued: boolean }> {
  return apiFetch(`${BASE}/${enc(id)}/backup`, {
    method: "POST",
    body: allowEmptyOnce ? { allowEmptyOnce: true } : {},
  });
}

export function retireShare(id: string): Promise<FileShareDetail> {
  return apiFetch<FileShareDetail>(`${BASE}/${enc(id)}/retire`, { method: "POST" });
}

export function reactivateShare(id: string): Promise<FileShareDetail> {
  return apiFetch<FileShareDetail>(`${BASE}/${enc(id)}/reactivate`, { method: "POST" });
}

export function purgeShare(id: string, confirmName: string): Promise<{ queued: boolean }> {
  return apiFetch(`${BASE}/${enc(id)}`, { method: "DELETE", body: { confirmName } });
}

export function fetchRuns(id: string, limit = 50): Promise<{ items: ShareRun[] }> {
  return apiFetch(`${BASE}/${enc(id)}/runs${query({ limit })}`);
}

export function fetchRun(
  id: string,
  runId: string,
  options: { code?: string; limit?: number; offset?: number } = {},
): Promise<ShareRunDetail> {
  return apiFetch<ShareRunDetail>(
    `${BASE}/${enc(id)}/runs/${enc(runId)}${query({ code: options.code, limit: options.limit, offset: options.offset })}`,
  );
}

export function cancelRun(id: string, runId: string): Promise<ShareRun> {
  return apiFetch<ShareRun>(`${BASE}/${enc(id)}/runs/${enc(runId)}/cancel`, { method: "POST" });
}

export function fetchShareSnapshots(id: string): Promise<{ items: ShareSnapshot[] }> {
  return apiFetch(`${BASE}/${enc(id)}/snapshots`);
}

export function fetchShareBrowse(
  id: string,
  snapshotId: string,
  path: string,
  cursor: string | null,
): Promise<ShareBrowseResult> {
  return apiFetch<ShareBrowseResult>(
    `${BASE}/${enc(id)}/browse${query({ snapshot: snapshotId, path, cursor: cursor ?? undefined })}`,
  );
}

export function searchShare(
  id: string,
  q: string,
  snapshotId?: string,
): Promise<{ items: ShareSearchHit[]; truncated: boolean }> {
  return apiFetch(`${BASE}/${enc(id)}/search${query({ q, snapshot: snapshotId })}`);
}

export function fetchVersions(
  id: string,
  path: string,
): Promise<{ path: string; items: ShareVersion[] }> {
  return apiFetch(`${BASE}/${enc(id)}/versions${query({ path })}`);
}

export function createShareDownload(
  id: string,
  snapshotId: string,
  paths: readonly string[],
): Promise<{ id: string; expiresAt: string; items: number }> {
  return apiFetch(`${BASE}/${enc(id)}/downloads`, {
    method: "POST",
    body: { snapshotId, paths: [...paths] },
  });
}

/** The address a prepared download is started at (a navigation names the tenant in the query). */
export function shareDownloadUrl(id: string, downloadId: string, tenantId: string | null): string {
  return `${API_BASE_URL}${BASE}/${enc(id)}/downloads/${enc(downloadId)}${query({ tenant: tenantId ?? undefined })}`;
}

export function requestRestore(id: string, input: RestoreInput): Promise<ShareRun> {
  return apiFetch<ShareRun>(`${BASE}/${enc(id)}/restores`, { method: "POST", body: input });
}

export function requestVerify(id: string): Promise<{ queued: boolean }> {
  return apiFetch(`${BASE}/${enc(id)}/verify`, { method: "POST" });
}

export function setQuota(id: string, quotaGib: number | null): Promise<FileShareDetail> {
  return apiFetch<FileShareDetail>(`${BASE}/${enc(id)}/quota`, {
    method: "PUT",
    body: { quotaGib },
  });
}

export function setApproval(id: string, approved: boolean): Promise<FileShareDetail> {
  return apiFetch<FileShareDetail>(`${BASE}/${enc(id)}/private-network-approval`, {
    method: "PUT",
    body: { approved },
  });
}

export function revealRepositoryPassword(
  id: string,
): Promise<{ password: string; storagePrefix: string }> {
  return apiFetch(`${BASE}/${enc(id)}/repository-password`, { method: "POST" });
}

export function fetchInstallationShareSettings(): Promise<InstallationShareSettings> {
  return apiFetch<InstallationShareSettings>(`${BASE}/installation-settings`);
}

export function updateInstallationShareSettings(
  patch: Partial<
    Omit<InstallationShareSettingsValues, "tenantShareQuotaGibByTenant" | "catalog">
  > & {
    catalog?: Partial<InstallationShareSettingsValues["catalog"]>;
  },
): Promise<InstallationShareSettings> {
  return apiFetch<InstallationShareSettings>(`${BASE}/installation-settings`, {
    method: "PUT",
    body: patch,
  });
}
