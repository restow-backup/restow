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
  bitmapState: "incremental" | "full_read" | null;
  attention: string[];
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
  byteSize: number;
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
}

export interface PveGuestDetail {
  guest: PveGuest;
  cluster: { id: string; name: string; storageId: string } | null;
  snapshots: PveRestorePoint[];
  runs: PveRun[];
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
  apiFetch<{ taskId: string }>(`/pve/guests/${encodeURIComponent(id)}/backup`, {
    method: "POST",
    body: { verifyRead },
  });
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
