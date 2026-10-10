import type { FileShare, FileShareRun, FileShareSnapshot } from "@restow/db";
import { type FailureDto, failureDto } from "../failures/dto.js";
import type { ShareFact, ShareReadinessState, ShareStanding } from "./protection.js";

/**
 * What /api/v1/file-shares answers (docs/FILESHARES.md 9.1). The shapes are the contract of the
 * web app (apps/web/src/features/file-shares/api.ts mirrors them); times are ISO 8601 in UTC.
 * Never a password: `hasPassword` says whether one is stored.
 */

/** The parameters of a run as the page shows them (nothing secret is in them; bounded). */
export function fileShareRunParamsSafe(params: FileShareRun["params"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    "paths",
    "destination",
    "folder",
    "conflict",
    "restorePermissions",
    "verify",
    "mode",
    "targetFolder",
    "force",
    "allowEmptyOnce",
    "includes",
    "note",
  ]) {
    const value = params[key];
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.slice(0, 50) : value;
  }
  if (Array.isArray(params.paths)) {
    out.pathCount = params.paths.length;
  }
  return out;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

export interface ShareQuotaDto {
  /** Bytes the share's repository takes; null until measured. */
  usedBytes: number | null;
  /** The share's own budget in GiB; null = none. */
  quotaGib: number | null;
  /** The tenant's budget for all its shares in GiB; null = none. */
  tenantQuotaGib: number | null;
  tenantUsedBytes: number;
  /** The fuller of the two budgets, in percent; null without a budget. */
  percent: number | null;
  level: "ok" | "near" | "exceeded";
  refusedAt: string | null;
}

export interface ShareRunBriefDto {
  id: string;
  kind: "backup" | "restore";
  status: FileShareRun["status"];
  startedAt: string | null;
  queuedAt: string | null;
  finishedAt: string | null;
  progress: FileShareRun["progress"];
}

export interface FileShareSummaryDto {
  id: string;
  name: string;
  protocol: "smb" | "nfs";
  server: string;
  /** How the share is written: `\\server\share\sub` or `server:/export/sub`. */
  location: string;
  shareName: string | null;
  exportPath: string | null;
  subfolder: string;
  smbVersion: FileShare["smbVersion"];
  seal: boolean;
  nfsVersion: FileShare["nfsVersion"];
  username: string | null;
  domain: string | null;
  hasPassword: boolean;
  allowRestore: boolean;
  permissionsMode: "auto" | "off";
  rereadPermissions: boolean;
  retiredAt: string | null;
  createdAt: string;
  privateNetworkApproval: FileShare["privateNetworkApproval"];
  lastTest: FileShare["lastTest"];
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
    failure: FailureDto | null;
  } | null;
  activeRun: ShareRunBriefDto | null;
  lastBackupAt: string | null;
  lastSuccessAt: string | null;
  restorePoints: number;
  repository: { readyAt: string | null; bytes: number | null };
  quotaGib: number | null;
  catalog: { at: string | null };
}

export interface ShareRunDto {
  id: string;
  kind: "backup" | "restore";
  status: FileShareRun["status"];
  trigger: FileShareRun["trigger"];
  backupJobId: string | null;
  /** The share the run backs up, or the source of a restore. */
  fileShareId: string;
  /** The share a restore writes into. */
  targetShareId: string | null;
  sourceSnapshotId: string | null;
  params: Record<string, unknown>;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastProgressAt: string | null;
  progress: FileShareRun["progress"];
  stats: FileShareRun["stats"];
  itemCount: number;
  failure: FailureDto | null;
  errorMessage: string | null;
  cancelRequestedAt: string | null;
  snapshotId: string | null;
}

export interface ShareRunDetailDto extends ShareRunDto {
  logTail: string | null;
  itemsStored: number;
  /** Items per code (all of the run, also those not stored). */
  itemCounts: Record<string, number>;
  items: { path: string; code: string; phase: string; message: string }[];
  /** The throughput samples of the run (bytes and files done over time). */
  samples: { at: string; bytesDone: number; filesDone: number }[];
}

export interface ShareSnapshotDto {
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
  permissions: FileShareSnapshot["permissions"];
  verification: { state: "green" | "yellow" | "red" | "unverified"; checkedAt: string | null };
  cataloged: boolean;
}

/** The location as the people who set up the server write it. */
export function locationOf(
  share: Pick<FileShare, "protocol" | "server" | "shareName" | "exportPath" | "subfolder">,
): string {
  const sub = share.subfolder ? share.subfolder.split("/").filter(Boolean) : [];
  if (share.protocol === "smb") {
    return [`\\\\${share.server}`, share.shareName ?? "", ...sub].join("\\");
  }
  const exportPath = share.exportPath ?? "/";
  return `${share.server}:${[exportPath.replace(/\/$/, ""), ...sub].join("/") || "/"}`;
}

export function shareSummaryDto(fact: ShareFact): FileShareSummaryDto {
  const share = fact.share;
  return {
    id: share.id,
    name: share.name,
    protocol: share.protocol,
    server: share.server,
    location: locationOf(share),
    shareName: share.shareName,
    exportPath: share.exportPath,
    subfolder: share.subfolder,
    smbVersion: share.smbVersion,
    seal: share.smbEncryption,
    nfsVersion: share.nfsVersion,
    username: share.username,
    domain: share.smbDomain,
    hasPassword: share.credentialSecretId !== null,
    allowRestore: share.allowRestore,
    permissionsMode: share.permissionsMode,
    rereadPermissions: share.rereadPermissions,
    retiredAt: iso(share.retiredAt),
    createdAt: share.createdAt.toISOString(),
    privateNetworkApproval: share.privateNetworkApproval,
    lastTest: share.lastTest,
    credentialFailedAt: iso(share.credentialFailedAt),
    job: fact.job,
    includes: fact.includes,
    protected: fact.protected,
    standing: fact.standing,
    readiness: {
      state: fact.readiness.state,
      checkedAt: iso(fact.readiness.checkedAt),
      overdue: fact.readiness.overdue,
    },
    lastRun: fact.lastBackupRun
      ? {
          id: fact.lastBackupRun.id,
          status: fact.lastBackupRun.status,
          finishedAt: iso(fact.lastBackupRun.finishedAt),
          failure: failureDto(fact.lastBackupRun.failure),
        }
      : null,
    activeRun: fact.activeRun
      ? {
          id: fact.activeRun.id,
          kind: fact.activeRun.kind,
          status: fact.activeRun.status,
          startedAt: iso(fact.activeRun.startedAt),
          queuedAt: iso(fact.activeRun.queuedAt),
          finishedAt: null,
          progress: fact.activeRun.progress,
        }
      : null,
    lastBackupAt: iso(share.lastBackupAt),
    lastSuccessAt: iso(share.lastSuccessAt),
    restorePoints: fact.restorePoints,
    repository: { readyAt: iso(share.repositoryReadyAt), bytes: share.repositoryBytes },
    quotaGib: share.quotaGib,
    catalog: { at: iso(share.lastCatalogAt) },
  };
}

export function shareRunDto(run: FileShareRun): ShareRunDto {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    trigger: run.trigger,
    backupJobId: run.backupJobId,
    fileShareId: run.fileShareId,
    targetShareId: run.targetShareId,
    sourceSnapshotId: run.sourceSnapshotId,
    params: fileShareRunParamsSafe(run.params),
    queuedAt: run.queuedAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    lastProgressAt: iso(run.lastProgressAt),
    progress: run.progress,
    stats: run.stats,
    itemCount: run.itemCount,
    failure: failureDto(run.failure),
    errorMessage: run.errorMessage,
    cancelRequestedAt: iso(run.cancelRequestedAt),
    snapshotId: run.snapshotId,
  };
}

export function shareSnapshotDto(
  snapshot: FileShareSnapshot,
  verification: ShareSnapshotDto["verification"],
): ShareSnapshotDto {
  return {
    id: snapshot.id,
    sequence: snapshot.sequence,
    resticSnapshotId: snapshot.resticSnapshotId,
    shortId: snapshot.resticSnapshotId.slice(0, 8),
    time: snapshot.snapshotTime.toISOString(),
    files: snapshot.files,
    dirs: snapshot.dirs,
    bytes: snapshot.bytes,
    bytesAdded: snapshot.bytesAdded,
    includes: snapshot.includes,
    permissions: snapshot.permissions,
    verification,
    cataloged: snapshot.catalogedAt !== null,
  };
}
