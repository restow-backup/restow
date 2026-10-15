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
  bitmapState: "incremental" | "full_read" | null;
  /** The first backup ever and the newest restore point; missing on servers before 0.3.5. */
  backups?: PveGuestBackupSizes;
  attention: string[];
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

export interface PveJob {
  id: string;
  name: string;
  scopeAll: boolean;
  schedule: PveJobSchedule | null;
  settings: {
    mode?: "snapshot" | "suspend" | "stop";
    retention?: { keepDaily: number; keepWeekly: number; keepMonthly: number };
    restoreTest?: { enabled: boolean; targetStorage?: string };
  };
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

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
  disks: {
    device: string;
    size: number;
    changedBlocks: number;
    zeroBlocks: number;
    dataBlocks: number;
    bitmapMode: string;
  }[];
  verify: { checkedAt: string; blocks: number; mismatched: number; errors: string[] } | null;
}

export interface PveRun {
  id: string;
  kind: "backup" | "restore" | "restore_test" | "verify";
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
  } | null;
  /** How far the run is while it runs; missing on servers before 0.4.0. */
  progress?: PveRunProgress | null;
}

export interface PveGuestDetail {
  guest: PveGuest;
  cluster: { id: string; name: string; storageId: string } | null;
  snapshots: PveRestorePoint[];
  runs: PveRun[];
  /** What a follow-up backup added on average; missing on servers before 0.3.7. */
  followUp?: PveFollowUpAverage | null;
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
  guest: (tenantId: string | null, id: string) => ["pve", tenantId, "guest", id] as const,
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
export const saveJob = (id: string | null, input: JobInput) =>
  id
    ? apiFetch<PveJob>(`/pve/jobs/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: input,
      })
    : apiFetch<PveJob>("/pve/jobs", { method: "POST", body: input });
export const deleteJob = (id: string) =>
  apiFetch<void>(`/pve/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
