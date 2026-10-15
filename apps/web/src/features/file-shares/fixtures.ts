import type { Failure } from "@/features/failures/api";

import type {
  FileShareDetail,
  FileShareList,
  ShareRun,
  ShareRunDetail,
  ShareSnapshot,
  ShareTestResult,
  TenantShareSettings,
} from "./api.js";

/**
 * Fixtures of the file share tests (not part of the app bundle: nothing imports this file outside
 * `*.test.*` and testing.tsx). The shapes are the ones of the API's DTOs (apps/api
 * features/file-shares/dto.ts).
 */

export const NOW = Date.parse("2026-10-10T10:00:00.000Z");
export const iso = (offsetMinutes = 0): string =>
  new Date(NOW + offsetMinutes * 60_000).toISOString();

export const SHARE_ID = "5a1e0000-0000-4000-8000-000000000001";
export const OTHER_ID = "5a1e0000-0000-4000-8000-000000000002";
export const SNAPSHOT_ID = "5a1e0000-0000-4000-8000-0000000000a1";

export function shareFixture(over: Partial<FileShareDetail> = {}): FileShareDetail {
  return {
    id: SHARE_ID,
    name: "Projects",
    protocol: "smb",
    server: "files.example.com",
    location: "\\\\files.example.com\\Projects",
    shareName: "Projects",
    exportPath: null,
    subfolder: "",
    smbVersion: "3.1.1",
    seal: false,
    nfsVersion: null,
    username: "backup",
    domain: "CORP",
    hasPassword: true,
    allowRestore: true,
    permissionsMode: "auto",
    rereadPermissions: false,
    retiredAt: null,
    createdAt: iso(-60 * 24 * 30),
    privateNetworkApproval: null,
    lastTest: { ok: true, code: null, at: iso(-60), durationMs: 1200 },
    credentialFailedAt: null,
    job: { id: "job-share", name: "File server, nightly", enabled: true },
    includes: [],
    protected: true,
    standing: "ok",
    readiness: { state: "green", checkedAt: iso(-120), overdue: false },
    lastRun: null,
    activeRun: null,
    lastBackupAt: iso(-600),
    lastSuccessAt: iso(-600),
    restorePoints: 12,
    repository: { readyAt: iso(-60 * 24 * 30), bytes: 5 * 1024 ** 3 },
    quotaGib: null,
    catalog: { at: iso(-600) },
    runs: [],
    copyJobs: [],
    quota: {
      usedBytes: 5 * 1024 ** 3,
      quotaGib: null,
      tenantQuotaGib: null,
      tenantUsedBytes: 5 * 1024 ** 3,
      percent: null,
      level: "ok",
      refusedAt: null,
    },
    ...over,
  };
}

export function listFixture(items: FileShareDetail[] = [shareFixture()]): FileShareList {
  return {
    items,
    counts: {
      total: items.length,
      protected: items.filter((item) => item.protected).length,
      withoutJob: items.filter((item) => item.job === null).length,
      failed: items.filter((item) => item.standing === "failed").length,
      warnings: 0,
      lastSuccessAt: items[0]?.lastSuccessAt ?? null,
    },
  };
}

export function settingsFixture(over: Partial<TenantShareSettings> = {}): TenantShareSettings {
  return {
    runner: { available: true, ready: true, blockers: [], running: 0, limit: 4 },
    enableCommand: "./restow mounter enable",
    tenantsMayUsePrivateNetworks: false,
    maxRunHours: 72,
    catalogEnabled: true,
    tenantQuotaGib: null,
    defaultShareQuotaGib: null,
    ...over,
  };
}

export function failureFixture(code: string, over: Partial<Failure> = {}): Failure {
  return {
    code,
    category: "share",
    transient: false,
    retryable: true,
    params: {},
    technical: {},
    occurredAt: iso(-1),
    step: "mount",
    retry: null,
    steps: [{ id: "check_share_account", target: "file_share" }],
    docsUrl: "https://docs.example.test/troubleshooting",
    ...over,
  };
}

export function testResultFixture(over: Partial<ShareTestResult> = {}): ShareTestResult {
  return {
    ok: true,
    code: null,
    cause: null,
    failure: null,
    params: {},
    detail: null,
    fsType: "cifs",
    entries: [
      { name: "Finance", type: "dir", size: 0, mtime: iso(-100) },
      { name: "Marketing", type: "dir", size: 0, mtime: iso(-100) },
      { name: "readme.txt", type: "file", size: 120, mtime: iso(-100) },
    ],
    truncated: false,
    permissions: { readable: true, xattr: "system.cifs_ntsd" },
    durationMs: 900,
    address: "93.184.216.34",
    testedAt: iso(),
    ...over,
  };
}

export function snapshotFixture(over: Partial<ShareSnapshot> = {}): ShareSnapshot {
  return {
    id: SNAPSHOT_ID,
    sequence: 12,
    resticSnapshotId: "a1b2c3d4e5f6",
    shortId: "a1b2c3d4",
    time: iso(-600),
    files: 1200,
    dirs: 80,
    bytes: 4 * 1024 ** 3,
    bytesAdded: 12 * 1024 ** 2,
    includes: [],
    permissions: {
      mode: "auto",
      xattr: "system.cifs_ntsd",
      entries: 1280,
      descriptors: 14,
      errors: 0,
    },
    verification: { state: "green", checkedAt: iso(-500) },
    cataloged: true,
    ...over,
  };
}

export function runFixture(over: Partial<ShareRun> = {}): ShareRun {
  return {
    id: "run-1",
    kind: "backup",
    status: "succeeded",
    trigger: "schedule",
    backupJobId: "job-share",
    fileShareId: SHARE_ID,
    targetShareId: null,
    sourceSnapshotId: null,
    params: {},
    queuedAt: iso(-620),
    startedAt: iso(-619),
    finishedAt: iso(-600),
    lastProgressAt: iso(-600),
    progress: null,
    stats: { files: 1200, bytes: 4 * 1024 ** 3, dataAdded: 12 * 1024 ** 2 },
    itemCount: 0,
    failure: null,
    errorMessage: null,
    cancelRequestedAt: null,
    snapshotId: SNAPSHOT_ID,
    ...over,
  };
}

export function runDetailFixture(over: Partial<ShareRunDetail> = {}): ShareRunDetail {
  return {
    ...runFixture(),
    logTail: null,
    itemsStored: 0,
    itemCounts: {},
    items: [],
    samples: [],
    ...over,
  };
}
