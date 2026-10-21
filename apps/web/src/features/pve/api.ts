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
  /** The node's queue is paused (0.4.2): since when and by whom; missing on older servers. */
  queuePausedAt?: string | null;
  queuePausedBy?: string | null;
  /** Backups that wait for the node. */
  queuedBackups?: number;
  /** The restow-pve release the node would update to; null when it is up to date. */
  updateVersion?: string | null;
  /** "Update now" was asked for and the node has not reported the release yet. */
  updateRequestedAt?: string | null;
  /** The restow-pve release the server offers (0.4.3); missing on older servers. */
  offeredVersion?: string | null;
  /** The node runs an older restow-pve than the server offers (0.4.3). */
  outdated?: boolean;
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
  /** Who stopped the last backup when it ended cancelled (0.4.2). */
  lastRunCancelledBy?: string | null;
  /** A stop was asked for and the node has not ended the backup yet ("Cancelling", 0.4.2). */
  cancelling?: boolean;
  cancelledBy?: string | null;
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
  /**
   * vzdump's warnings beside the newest backup, which committed its restore point ("Succeeded
   * with warnings"); missing on servers before 0.4.2.
   */
  lastRunWarnings?: string[];
  /**
   * The guest is the VM this Restow installation runs in: found by its SMBIOS UUID, or marked by
   * an admin; null otherwise. Missing on servers before 0.4.2.
   */
  restowServer?: "detected" | "flagged" | null;
  restowServerFlagged?: boolean;
  /** An admin confirmed backing up the Restow server's own VM anyway. */
  selfBackupConfirmedAt?: string | null;
  /** The restore check of the newest restore point; missing on servers before 0.4.2. */
  lastVerify?: PveVerifyFact | null;
}

/** Why a restore check could not run (servers from 0.4.3). */
export interface PveVerifyNotChecked {
  reason: "locked" | "interrupted";
  /** What restic said, e.g. who holds the repository's lock. */
  detail: string;
  attempts: number;
  gaveUpAt?: string;
}

/** The restore check of a guest's newest restore point, with what it found. */
export interface PveVerifyFact {
  /** yellow: the check could not run (servers from 0.4.3). */
  state: "green" | "yellow" | "red" | null;
  checkedAt: string | null;
  /** The stored errors (the real restic or read error), the first five. */
  errors: string[];
  /** A check of it waits for the worker's next pass. */
  requested: boolean;
  /** The newest check could not run (`gaveUp`: no more tries); servers from 0.4.3. */
  notChecked?: {
    reason: "locked" | "interrupted";
    detail: string;
    attempts: number;
    gaveUp: boolean;
  } | null;
}

/** Whether "Back up now" or putting the guest into a job needs the self-backup confirmation. */
export function selfBackupBlocked(
  guest: Pick<PveGuest, "restowServer" | "selfBackupConfirmedAt">,
): boolean {
  return Boolean(guest.restowServer) && !guest.selfBackupConfirmedAt;
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
  kind: "daily" | "interval" | "cron";
  timeOfDay?: string;
  intervalMinutes?: number;
  /** Weekdays, monthly or custom (servers from 0.4.2). */
  cron?: string;
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
  verify: {
    /** Missing on a record of a check that could not run (`notChecked`, servers from 0.4.3). */
    checkedAt?: string;
    blocks: number;
    mismatched: number;
    errors: string[];
    /**
     * The newest check could not run (the repository was locked, or the check was stopped):
     * still tried again without `gaveUpAt`, the fields above being the previous result;
     * with it, the restore point is not checked (servers from 0.4.3).
     */
    notChecked?: PveVerifyNotChecked;
  } | null;
  /** A check of this restore point waits for the worker's next pass (servers from 0.4.2). */
  verifyRequested?: boolean;
  /** The newest rated boot test of the restore point; missing on older servers. */
  bootTest?: PveBootTest | null;
  /**
   * False for a container restore point of an earlier backup chain: its repository is gone,
   * so it can be neither restored nor checked (0.4.2 on; missing means available).
   */
  available?: boolean;
  unavailableAt?: string | null;
}

export interface PveRun {
  id: string;
  kind: "backup" | "restore" | "restore_test" | "verify" | "boot_test";
  origin: "restow" | "pve";
  status: "running" | "succeeded" | "failed" | "cancelled";
  archiveName: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** vzdump's warnings beside a backup that committed its restore point (servers from 0.4.2). */
  warnings?: string[];
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
  /** When a stop was asked for (0.4.2) and by whom: "Cancelling" while running, then "Cancelled by". */
  cancelRequestedAt?: string | null;
  cancelledBy?: string | null;
}

/** A task that waits for the guest's node (backup, restore, boot test). */
export interface PveOpenTask {
  id: string;
  kind: string;
  status: "pending" | "delivered";
  createdAt: string;
  /** A stop was asked for while the node has it (0.4.2). */
  cancelRequestedAt?: string | null;
  cancelledBy?: string | null;
}

/**
 * A new backup chain of a container's repository (docs/PVE.md, "New backup chain"): the
 * repository was missing on the primary when a backup began, or an administrator reset it.
 */
export interface PveRepositoryChain {
  at: string;
  reason: "missing" | "reset";
  /** Where the repository was looked for; `location` is null for the installation default. */
  target: {
    name: string;
    kind: string | null;
    location: string | null;
    installationDefault: boolean;
  } | null;
  unavailablePoints: number;
  actor: string | null;
}

export interface PveGuestDetail {
  guest: PveGuest;
  cluster: { id: string; name: string; storageId: string } | null;
  snapshots: PveRestorePoint[];
  runs: PveRun[];
  /** A container's repository and its new backup chains (newest first); null for a VM, missing before 0.4.2. */
  repository?: { readyAt: string | null; chains: PveRepositoryChain[] } | null;
  /** The guest's open tasks; missing on old servers. */
  tasks?: PveOpenTask[];
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
/** What a cancel did: backups withdrawn from the queue, backups asked to stop. */
export interface PveCancelResult {
  withdrawn: number;
  stopping: number;
}
/** Stop the guest's running backup and withdraw its queued ones (0.4.2). */
export const cancelGuestBackup = (id: string) =>
  apiFetch<PveCancelResult>(`/pve/guests/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: {},
  });
/** Withdraw every queued backup of a node, or of the tenant without a node. */
export const cancelQueuedBackups = (nodeId: string | null) =>
  apiFetch<PveCancelResult>(
    nodeId ? `/pve/nodes/${encodeURIComponent(nodeId)}/queue/cancel` : "/pve/queue/cancel",
    { method: "POST", body: {} },
  );
/** Pause or resume a node's queue: no backup starts there while it is paused. */
export const setNodeQueuePaused = (nodeId: string, paused: boolean) =>
  apiFetch<{ queuePausedAt: string | null; queuePausedBy: string | null }>(
    `/pve/nodes/${encodeURIComponent(nodeId)}/queue/${paused ? "pause" : "resume"}`,
    { method: "POST", body: {} },
  );
/** The node installs the offered restow-pve release as soon as it is idle. */
export const requestNodeUpdate = (nodeId: string) =>
  apiFetch<{ updateRequestedAt: string }>(`/pve/nodes/${encodeURIComponent(nodeId)}/update`, {
    method: "POST",
    body: {},
  });
export const backupNow = (
  id: string,
  verifyRead = false,
  options: { confirmSelfBackup?: boolean } = {},
) =>
  apiFetch<{ taskId: string; alreadyQueued?: boolean }>(
    `/pve/guests/${encodeURIComponent(id)}/backup`,
    {
      method: "POST",
      body: { verifyRead, ...(options.confirmSelfBackup ? { confirmSelfBackup: true } : {}) },
    },
  );
export const assignJob = (
  guestId: string,
  jobId: string | null,
  options: { confirmSelfBackup?: boolean } = {},
) =>
  apiFetch<void>(`/pve/guests/${encodeURIComponent(guestId)}/job`, {
    method: "PUT",
    body: { jobId, ...(options.confirmSelfBackup ? { confirmSelfBackup: true } : {}) },
  });
/** Mark a guest as the Restow server's own VM, or take the mark back (docs/PVE.md). */
export const setRestowServer = (guestId: string, flagged: boolean) =>
  apiFetch<void>(`/pve/guests/${encodeURIComponent(guestId)}/restow-server`, {
    method: "PUT",
    body: { flagged },
  });
/** Check a guest's newest restore point now (Recovery readiness). */
export const verifyGuest = (guestId: string) =>
  apiFetch<{ snapshotId: string }>(`/pve/guests/${encodeURIComponent(guestId)}/verify`, {
    method: "POST",
    body: {},
  });
/** Check the newest restore point of every guest no check has read yet. */
export const verifyUnverifiedGuests = () =>
  apiFetch<{ queued: number }>("/pve/verify-unverified", { method: "POST", body: {} });

/** The installation's Proxmox VE settings (GET/PUT /settings/pve). */
export interface PveInstallationSettings {
  verifyAfterBackup: boolean;
}
export const fetchPveSettings = () =>
  apiFetch<{ settings: PveInstallationSettings; defaults: PveInstallationSettings }>(
    "/settings/pve",
  );
export const savePveSettings = (input: Partial<PveInstallationSettings>) =>
  apiFetch<{ settings: PveInstallationSettings; defaults: PveInstallationSettings }>(
    "/settings/pve",
    { method: "PUT", body: input },
  );
export const restoreSnapshot = (
  id: string,
  input: { targetStorage: string; targetNode?: string; targetVmid?: number; start: boolean },
) =>
  apiFetch<{ taskId: string }>(`/pve/snapshots/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    body: input,
  });
/** Reset a container's repository (typed name, recent sign-in): a new chain begins. */
export const resetRepository = (id: string, confirmName: string) =>
  apiFetch<{ unavailablePoints: number }>(
    `/pve/guests/${encodeURIComponent(id)}/repository/reset`,
    { method: "POST", body: { confirmName } },
  );
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
