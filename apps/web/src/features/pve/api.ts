import type { BrowseResult, PreparedDownload } from "@/features/endpoints/api";
import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/pve (apps/api/src/features/pve: service.ts for
 * the responses, schemas.ts for the requests). Query keys carry the tenant.
 */

export interface PveNode {
  id: string;
  name: string;
  helperVersion: string | null;
  pveVersion: string | null;
  fleecingStorage: string | null;
  lastSeenAt: string | null;
  online: boolean;
  problems: string[];
  pluginLoaded: boolean | null;
  restoresAllowed: boolean | null;
  /** What the node runs beyond backups and restores ("boot_test"); missing on older servers. */
  capabilities?: string[];
}

export interface PveCluster {
  id: string;
  name: string;
  storageId: string;
  nodes: PveNode[];
}

export type GuestKind = "vm" | "ct";

export interface PveGuest {
  id: string;
  clusterId: string;
  vmid: number;
  kind: GuestKind;
  name: string | null;
  node: string | null;
  status: string | null;
  template: boolean;
  privileged: boolean;
  present: boolean;
  diskBytes: number;
  jobId: string | null;
  jobName: string | null;
  lastBackupAt: string | null;
  lastSuccessAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  /** What is happening now: the backup was handed to the node, or runs; null otherwise (and on older servers). */
  activity?: "queued" | "running" | null;
  /** Since when the guest waits for its node or its backup runs; missing on servers before 0.4.0. */
  activitySince?: string | null;
  /** How far the running backup is; null before the node's first report and for nodes before 0.4.0. */
  progress?: PveRunProgress | null;
  /**
   * The job whose scheduled round the backup belongs to; null for one asked for by hand ("Back up
   * now") or started in PVE. Missing on servers before 0.4.0.
   */
  activityJobId?: string | null;
  /** The running backup's run. */
  activityRunId?: string | null;
  /** The node the running backup runs on and its restow-pve version; missing on servers before 0.4.1. */
  activityNode?: PveRunNode | null;
  bitmapState: "incremental" | "full_read" | null;
  /** The first backup ever and the newest restore point; missing on servers before 0.3.5. */
  backups?: PveGuestBackupSizes;
  attention: string[];
}

/** The node of a running backup and the restow-pve version it last reported. */
export interface PveRunNode {
  name: string;
  helperVersion: string | null;
}

/**
 * How far a running backup is, as its node reported last (#51): bytes read of
 * the total to read (null while unknown), bytes uploaded (VMs) and the read
 * throughput between the last two reports.
 */
export interface PveRunProgress {
  bytesDone: number;
  bytesTotal: number | null;
  bytesUploaded: number | null;
  bytesPerSecond: number | null;
  at: string;
}

/**
 * The sizes of one restore point: what it contains (everything it restores)
 * and what it added to the repository (null when the point did not record it).
 */
export interface PveBackupSize {
  at: string;
  contains: number;
  added: number | null;
  /** Items a container backup could not read; the point misses them. */
  unreadable: number;
}

/** What a follow-up backup added on average, over the newest `points` restore points after the first. */
export interface PveFollowUpAverage {
  added: number;
  points: number;
}

export interface PveGuestBackupSizes {
  first: PveBackupSize | null;
  last: PveBackupSize | null;
  /** Null without a follow-up backup that recorded it; missing on servers before 0.3.7. */
  followUp?: PveFollowUpAverage | null;
}

export interface PveJobSchedule {
  kind: "daily" | "interval";
  timeOfDay?: string;
  intervalMinutes?: number;
  timeZone: string;
}

/** Where a job's scheduled round stands while guests of it still wait or run. */
export interface PveJobRound {
  since: string;
  total: number;
  done: number;
  failed: number;
  running: number;
  queued: number;
}

export interface PveJob {
  id: string;
  name: string;
  scopeAll: boolean;
  schedule: PveJobSchedule | null;
  settings: {
    mode?: "snapshot" | "suspend" | "stop";
    retention?: { keepDaily: number; keepWeekly: number; keepMonthly: number };
    restoreTest?: { enabled: boolean; targetStorage?: string };
    /** Boot tests of the job's guests; off when missing. */
    bootTest?: PveBootTestSettings;
  };
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Made by "Create recommended job" (0.4.0 on). */
  recommended?: boolean;
  /** The guests the job backs up (0.4.0 on). */
  guestCount?: number;
  /** The scheduled round while it goes; null otherwise (0.4.0 on). */
  round?: PveJobRound | null;
}

export type PveBootTestSchedule = "off" | "weekly" | "after_backup";

export interface PveBootTestSettings {
  schedule: PveBootTestSchedule;
  maxMemoryMiB?: number;
  timeoutSeconds?: number;
}

/**
 * A boot test of a restore point (docs/PVE.md, "Boot test"): green only when the restored VM's
 * QEMU guest agent answered (a container: its init runs), yellow when the VM only started, red
 * when the restore, the start or the boot failed; skipped and error say why it did not run.
 */
export type PveBootTestOutcome = "green" | "yellow" | "red" | "skipped" | "error";

export interface PveBootTest {
  outcome: PveBootTestOutcome;
  reason: string;
  message: string;
  checkedAt: string;
  durationMs: number;
  bootSeconds: number | null;
  guestAgent: boolean;
  tempVmid: number | null;
  storage: string | null;
  cleanedUp: boolean;
}

/** Why a guest's restore points cannot be boot-tested; null: they can. */
export type PveBootTestBlocker =
  | "no_node"
  | "node_unsupported"
  | "restores_off"
  | "privileged"
  | "template"
  | null;

export interface PveOverview {
  clusters: PveCluster[];
  guests: PveGuest[];
  jobs: PveJob[];
  restorePool: string;
}

export interface PveRestorePoint {
  id: string;
  sequence: number;
  kind: GuestKind;
  archiveName: string;
  origin: "restow" | "pve";
  backupAt: string;
  /** Everything the point contains: a container's files, a VM's disks. */
  byteSize: number;
  /** What this point added to the repository; null when not recorded (older points, older servers). */
  added?: number | null;
  backupType?: "first" | "incremental" | "full_read";
  /** Items a container backup could not read (0 when complete). */
  unreadable?: number;
  consistency?: string | null;
  /** The first unreadable items, when the node named them (0.4.0 on). */
  stats?: { unreadablePaths?: string[] } | null;
  /**
   * What a container restore point holds, as paths in the container: `/` and the mount points
   * vzdump includes; null for a VM. Missing on servers before 0.4.0.
   */
  contents?: string[] | null;
  /** Whether its files can be browsed and downloaded (containers, 0.4.0 on). */
  browsable?: boolean;
  disks: {
    device: string;
    size: number;
    changedBlocks: number;
    zeroBlocks: number;
    dataBlocks: number;
    bitmapMode: string;
  }[];
  verify: { checkedAt: string; blocks: number; mismatched: number; errors: string[] } | null;
  /** The newest rated boot test of the restore point; missing on older servers. */
  bootTest?: PveBootTest | null;
}

export interface PveRun {
  id: string;
  kind: "backup" | "restore" | "restore_test" | "verify" | "boot_test";
  origin: "restow" | "pve";
  status: "running" | "succeeded" | "failed";
  archiveName: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  stats?: {
    resticUnreadable?: number;
    /** The first items restic could not read (nodes from 0.4.0 on). */
    unreadablePaths?: string[];
    consistency?: string | null;
    /** The outcome of a boot test run. */
    bootTest?: PveBootTest;
  } | null;
  /** How far the run is while it runs; missing on servers before 0.4.0. */
  progress?: PveRunProgress | null;
  /** The node a running run runs on and its restow-pve version; missing on servers before 0.4.1. */
  node?: PveRunNode | null;
}

export interface PveGuestDetail {
  guest: PveGuest;
  cluster: { id: string; name: string; storageId: string } | null;
  snapshots: PveRestorePoint[];
  runs: PveRun[];
  /** What a follow-up backup added on average; missing on servers before 0.3.7. */
  followUp?: PveFollowUpAverage | null;
  /** Whether the guest's node can boot-test, the job's schedule, the last test; missing on older servers. */
  bootTest?: {
    blocker: PveBootTestBlocker;
    schedule: PveBootTestSchedule;
    lastBootTestAt: string | null;
  };
}

/** A one-time enrollment token and the one command that connects a node with it. */
export interface CreatedPveToken {
  id: string;
  token: string;
  expiresAt: string;
  /** The existing PVE API token the node gets with this enrollment, or null (it creates its own). */
  pveTokenId: string | null;
  nodeCommand: string;
}

/** An existing PVE API token an admin hands to an enrollment instead of the node's own. */
export interface ExistingPveToken {
  id: string;
  secret: string;
}

export interface JobInput {
  name: string;
  scopeAll: boolean;
  schedule: PveJobSchedule | null;
  enabled: boolean;
  settings: PveJob["settings"];
}

export const pveKeys = {
  all: (tenantId: string | null) => ["pve", tenantId] as const,
  overview: (tenantId: string | null) => ["pve", tenantId, "overview"] as const,
  activity: (tenantId: string | null) => ["pve", tenantId, "activity"] as const,
  guest: (tenantId: string | null, id: string) => ["pve", tenantId, "guest", id] as const,
  files: (tenantId: string | null, snapshotId: string, path: string) =>
    ["pve", tenantId, "files", snapshotId, path] as const,
};

/** How often the overview refreshes: often while a guest waits for its node or backs up (#51). */
export const OVERVIEW_REFRESH_MS = 30_000;
export const ACTIVE_REFRESH_MS = 5_000;

export function overviewRefreshMs(data: PveOverview | undefined): number {
  return data?.guests.some((guest) => guest.activity) ? ACTIVE_REFRESH_MS : OVERVIEW_REFRESH_MS;
}

/** How often a guest page refreshes: often while one of its runs is still going. */
export function guestRefreshMs(data: PveGuestDetail | undefined): number {
  return data?.runs.some((run) => run.status === "running") ? ACTIVE_REFRESH_MS : 15_000;
}

export const fetchOverview = () => apiFetch<PveOverview>("/pve");

/** The guests that back up now and how many wait: what the sidebar shows (apps/api pve/activity.ts). */
export interface PveActivity {
  /** Whether the tenant has a Proxmox VE cluster at all. */
  connected: boolean;
  running: { id: string; vmid: number; name: string | null; jobName: string | null }[];
  queued: number;
}
export const fetchActivity = () => apiFetch<PveActivity>("/pve/activity");
export const fetchGuest = (id: string) =>
  apiFetch<PveGuestDetail>(`/pve/guests/${encodeURIComponent(id)}`);
export const createToken = (pveToken?: ExistingPveToken) =>
  apiFetch<CreatedPveToken>("/pve/tokens", {
    method: "POST",
    body: pveToken ? { pveToken } : {},
  });
export const revokeNode = (id: string) =>
  apiFetch<void>(`/pve/nodes/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    body: {},
  });
export const backupNow = (id: string, verifyRead = false) =>
  apiFetch<{ taskId: string; alreadyQueued?: boolean }>(
    `/pve/guests/${encodeURIComponent(id)}/backup`,
    {
      method: "POST",
      body: { verifyRead },
    },
  );
export const assignJob = (guestId: string, jobId: string | null) =>
  apiFetch<void>(`/pve/guests/${encodeURIComponent(guestId)}/job`, {
    method: "PUT",
    body: { jobId },
  });
export const restoreSnapshot = (
  id: string,
  input: { targetStorage: string; targetNode?: string; targetVmid?: number; start: boolean },
) =>
  apiFetch<{ taskId: string }>(`/pve/snapshots/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    body: input,
  });
export const verifySnapshot = (id: string) =>
  apiFetch<void>(`/pve/snapshots/${encodeURIComponent(id)}/verify`, {
    method: "POST",
    body: {},
  });
export const requestBootTest = (id: string) =>
  apiFetch<{ taskId: string; alreadyQueued: boolean }>(
    `/pve/snapshots/${encodeURIComponent(id)}/boot-test`,
    { method: "POST", body: {} },
  );
export const saveJob = (id: string | null, input: JobInput) =>
  id
    ? apiFetch<PveJob>(`/pve/jobs/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: input,
      })
    : apiFetch<PveJob>("/pve/jobs", { method: "POST", body: input });
export const deleteJob = (id: string) =>
  apiFetch<void>(`/pve/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });

// --- File restore of containers (#62) ---------------------------------------------

/** Entries one page of a container folder holds; "Load more" fetches the next page. */
export const FILES_PAGE = 1000;

/**
 * One page of a folder of a container or VM restore point (audited by the server). At `/` of a
 * VM, `unreadable` names the file systems of its disks the server cannot read, with the reason.
 */
export function fetchContainerFiles(
  snapshotId: string,
  path: string,
  cursor?: string | null,
): Promise<BrowseResult & { unreadable?: { name: string; reason: string }[] }> {
  const search = new URLSearchParams({ path, limit: String(FILES_PAGE) });
  if (cursor) {
    search.set("cursor", cursor);
  }
  return apiFetch<BrowseResult>(
    `/pve/snapshots/${encodeURIComponent(snapshotId)}/files?${search.toString()}`,
  );
}

/** Step one of a ZIP download: the server checks the selection and keeps it for ten minutes. */
export function createContainerDownload(
  snapshotId: string,
  paths: readonly string[],
): Promise<PreparedDownload> {
  return apiFetch<PreparedDownload>(`/pve/snapshots/${encodeURIComponent(snapshotId)}/downloads`, {
    method: "POST",
    body: { paths },
  });
}

const API_BASE_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? "/api/v1").replace(
  /\/+$/,
  "",
);

/** Step two: the address the browser is sent to; the tenant travels in the query (a navigation). */
export function containerDownloadUrl(
  snapshotId: string,
  downloadId: string,
  tenantId: string | null,
): string {
  const query = tenantId ? `?tenant=${encodeURIComponent(tenantId)}` : "";
  return `${API_BASE_URL}/pve/snapshots/${encodeURIComponent(snapshotId)}/downloads/${encodeURIComponent(downloadId)}${query}`;
}
