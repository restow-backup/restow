import type {
  BackupJob,
  BackupJobList,
  JobCandidate,
  JobDefaults,
  JobMember,
  JobRestoreCheck,
} from "./api.js";

/**
 * Fixtures of the jobs tests (not part of the app bundle: nothing imports this file
 * outside `*.test.*` and testing.tsx). The shapes are the ones the API's DTOs have.
 */

export const NOW = Date.parse("2026-10-02T10:00:00.000Z");
export const iso = (offsetMinutes = 0): string =>
  new Date(NOW + offsetMinutes * 60_000).toISOString();

export function restoreCheck(over: Partial<JobRestoreCheck> = {}): JobRestoreCheck {
  return {
    passed: 5,
    warning: 0,
    failed: 0,
    unverified: 1,
    noBackup: 0,
    total: 6,
    checkedAt: iso(-300),
    ...over,
  };
}

export function mailJob(over: Partial<BackupJob> = {}): BackupJob {
  return {
    id: "job-mail-all",
    kind: "mail",
    name: "All mailboxes, daily",
    enabled: true,
    archive: false,
    origin: "user",
    scopeMode: "all",
    schedule: { kind: "cron", cron: "0 2 * * *", timeZone: "Europe/Berlin" },
    verifySchedule: { kind: "cron", cron: "0 4 * * 0", timeZone: "Europe/Berlin" },
    repository: {
      id: "r1",
      name: "Primary S3",
      kind: "s3",
      role: "primary",
      status: "ok",
      objectLock: false,
    },
    retention: { policyId: null, policyName: "Standard 30 days", keep: null },
    scope: { count: 220, byKind: { mailbox: 214, onedrive: 6 }, overrides: 2 },
    lastRun: {
      at: iso(-360),
      failed: 0,
      partial: 0,
      running: 0,
      queued: 0,
      runId: "22222222-2222-4222-8222-222222222222",
    },
    nextRunAt: iso(1080),
    restoreCheck: restoreCheck({ passed: 210, unverified: 10, total: 220 }),
    state: "ok",
    settings: {},
    createdAt: iso(-60 * 24 * 30),
    updatedAt: iso(-60 * 24),
    ...over,
  };
}

export function endpointJob(over: Partial<BackupJob> = {}): BackupJob {
  return {
    id: "job-srv",
    kind: "endpoint",
    name: "Linux servers, daily",
    enabled: true,
    archive: false,
    origin: "user",
    scopeMode: "selected",
    schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
    verifySchedule: null,
    repository: {
      id: "r1",
      name: "Primary S3",
      kind: "s3",
      role: "primary",
      status: "ok",
      objectLock: false,
    },
    retention: {
      policyId: null,
      policyName: null,
      keep: { keepDaily: 14, keepWeekly: 8, keepMonthly: 6 },
    },
    scope: { count: 3, byKind: { server: 3 }, overrides: 1 },
    lastRun: {
      at: iso(-42),
      failed: 0,
      partial: 0,
      running: 0,
      queued: 0,
      runId: "55555555-5555-4555-8555-555555555555",
    },
    nextRunAt: iso(18),
    restoreCheck: restoreCheck({ passed: 3, unverified: 0, total: 3 }),
    state: "ok",
    settings: {
      paths: ["/etc", "/var/www"],
      excludes: ["*.tmp", "*.temp", "~$*", "*.swp", "*.part", "*.bak"],
      excludeLargerThanGib: 4,
      hooks: { pre: "db-dump" },
      bandwidthKbps: 20000,
      retention: { keepDaily: 14, keepWeekly: 8, keepMonthly: 6 },
    },
    createdAt: iso(-60 * 24 * 30),
    updatedAt: iso(-60 * 24),
    ...over,
  };
}

export function member(over: Partial<JobMember> = {}): JobMember {
  return {
    targetId: "m1",
    kind: "server",
    name: "FS-BERGISCH",
    detail: "Linux amd64",
    status: "active",
    covered: true,
    explicit: true,
    overrides: {},
    effective: {
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
      verifySchedule: null,
      settings: { paths: ["/etc", "/var/www"] },
    },
    lastBackup: { at: iso(-42), outcome: "succeeded" },
    restoreCheck: { state: "green", checkedAt: iso(-300) },
    pendingBackup: null,
    nextRunAt: iso(18),
    ...over,
  };
}

export function candidate(over: Partial<JobCandidate> = {}): JobCandidate {
  return {
    targetId: "m1",
    kind: "server",
    name: "FS-BERGISCH",
    detail: "Linux amd64",
    status: "active",
    job: null,
    ...over,
  };
}

export function defaults(
  kind: "mail" | "endpoint" = "mail",
  over: Partial<JobDefaults> = {},
): JobDefaults {
  return {
    kind,
    timeZone: "Europe/Berlin",
    schedule:
      kind === "mail"
        ? { kind: "interval", intervalMinutes: 480, timeZone: "Europe/Berlin" }
        : { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
    verifySchedule:
      kind === "mail" ? { kind: "cron", cron: "0 3 * * 0", timeZone: "Europe/Berlin" } : null,
    settings:
      kind === "endpoint"
        ? { paths: ["/etc", "/home"], excludes: ["**/.cache"], bandwidthKbps: null }
        : {},
    repository: {
      id: "r1",
      name: "Primary S3",
      kind: "s3",
      role: "primary",
      status: "ok",
      objectLock: false,
    },
    retentionPolicies: [
      { id: "p-default", name: "Standard 30 days", isDefault: true, cutoffDays: 30 },
      { id: "p-90", name: "Ninety days", isDefault: false, cutoffDays: 90 },
    ],
    endpointRetention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
    ...over,
  };
}

export function list(
  items: BackupJob[],
  uncovered = { mail: 0, endpoint: 0 },
  unscheduled = { mail: 0, endpoint: 0 },
): BackupJobList {
  return { items, uncovered, unscheduled };
}
