import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { type FailureRecordJson, timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { recoveryReadinessEnum } from "./jobs.js";
import { secrets } from "./secrets.js";
import { tenants } from "./tenants.js";

/**
 * Endpoint backup: servers and clients backed up by the Restow agent with
 * restic (docs/AGENT.md). Every table here is tenant-scoped (RLS, sql/rls.sql).
 *
 * The agent writes to a restic repository that lives in the tenant's primary
 * storage target under `endpoints/<endpoint id>/`; the server initialises it,
 * keeps its password sealed in `secrets` (`endpoints.repository_secret_id`)
 * and is the only party that prunes and checks it.
 */

/** `server` = always-on machine (daily schedule); `client` = laptop/desktop (on connect). */
export const endpointProfileEnum = pgEnum("endpoint_profile", ["server", "client"]);

/**
 * The operating systems of the agent contract. Windows is part of the contract
 * (docs/AGENT.md) but is not offered in 0.1.0: enrollment refuses it.
 */
export const endpointOsEnum = pgEnum("endpoint_os", ["linux", "windows", "darwin"]);

export const endpointArchEnum = pgEnum("endpoint_arch", ["amd64", "arm64"]);

/** `revoked` endpoints are refused everywhere; their repository stays restorable. */
export const endpointStatusEnum = pgEnum("endpoint_status", ["active", "revoked"]);

export const endpointRunKindEnum = pgEnum("endpoint_run_kind", [
  "backup",
  "restore",
  "verify_sample",
]);

/** `partial` = a snapshot exists but some files could not be read. */
export const endpointRunStatusEnum = pgEnum("endpoint_run_status", [
  "running",
  "succeeded",
  "partial",
  "failed",
]);

export const endpointTaskKindEnum = pgEnum("endpoint_task_kind", [
  "backup_now",
  "restore",
  "verify_sample",
  "update_config",
  "uninstall",
]);

/** `pending` -> `delivered` (the agent got it in a heartbeat) -> `done` or `failed`. */
export const endpointTaskStatusEnum = pgEnum("endpoint_task_status", [
  "pending",
  "delivered",
  "done",
  "failed",
]);

/** What a server-side report records. */
export const endpointReportKindEnum = pgEnum("endpoint_report_kind", [
  "restore_test",
  "repository_check",
  "retention",
]);

export type EndpointProfile = (typeof endpointProfileEnum.enumValues)[number];
export type EndpointOs = (typeof endpointOsEnum.enumValues)[number];
export type EndpointArch = (typeof endpointArchEnum.enumValues)[number];
export type EndpointStatus = (typeof endpointStatusEnum.enumValues)[number];
export type EndpointRunKind = (typeof endpointRunKindEnum.enumValues)[number];
export type EndpointRunStatus = (typeof endpointRunStatusEnum.enumValues)[number];
export type EndpointTaskKind = (typeof endpointTaskKindEnum.enumValues)[number];
export type EndpointTaskStatus = (typeof endpointTaskStatusEnum.enumValues)[number];
export type EndpointReportKind = (typeof endpointReportKindEnum.enumValues)[number];

/** When the agent backs up (the `GET /agent/v1/config` contract). */
export type EndpointSchedule = {
  kind: "interval" | "daily" | "on_connect";
  /** `interval`: minutes between backups; `on_connect`: the least minutes between two backups. */
  intervalMinutes?: number;
  /** `daily`: local time `HH:MM`. */
  timeOfDay?: string;
  /** IANA zone `timeOfDay` is read in. */
  timeZone: string;
};

/**
 * A time window of the week with its own upload limit (the rules are in @restow/core
 * backup-jobs/bandwidth.ts): the days it starts on (1 = Monday ... 7 = Sunday), local start and end
 * as `HH:MM` (the end may be on the next day), and the limit in kbit/s (0 = unlimited).
 */
export type EndpointBandwidthWindow = {
  days: number[];
  from: string;
  to: string;
  kbps: number;
};

/** What the agent is told to back up and how (the agent contract, docs/AGENT.md). */
export type EndpointConfig = {
  profile: EndpointProfile;
  schedule: EndpointSchedule;
  paths: string[];
  excludes: string[];
  hooks: { pre?: string; post?: string };
  bandwidthKbps: number | null;
  onlyOnAcPower: boolean;
  useVss: boolean;
  /**
   * Skip files larger than this many bytes (restic `--exclude-larger-than`). Written from a backup
   * job only; absent when no job sets it. An agent that does not know the field ignores it.
   */
  excludeLargerThanBytes?: number;
  /**
   * Windows with their own upload limit, read in the zone of `schedule`; written from a backup job
   * (or by hand on a machine without one) and absent when there are none. `bandwidthKbps` is the
   * limit outside every window. The agent never sees them: `GET /agent/v1/config` answers with the
   * limit that applies at that moment.
   */
  bandwidthWindows?: EndpointBandwidthWindow[];
};

/** Retention of one endpoint's repository (`restic forget --keep-*`). */
export type EndpointRetention = {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
};

/**
 * Settings only the server uses; never sent to the agent. Every field is
 * optional, a missing one takes its documented default (docs/AGENT.md).
 */
export type EndpointSettings = {
  retention?: EndpointRetention;
  /**
   * The storage budget of this endpoint's repository in GiB; without it the
   * installation's default applies (`RESTOW_ENDPOINT_QUOTA_GIB`). The tenant's
   * budget for all its endpoints still caps it.
   */
  quotaGib?: number | null;
  /** Server profile: hours without contact before the alert (default 2). */
  staleAfterHours?: number;
  /** Client profile: days without a backup before the alert (default 7). */
  staleAfterDays?: number;
  /**
   * The tenant paused automatic agent updates (docs/AGENT.md, "Self-update"):
   * the tenant-wide switch is stored on each of its endpoints, and a new
   * endpoint takes it over from the tenant's others.
   */
  autoUpdatePaused?: boolean;
  /** What the agent reports about the machine; written by the server from enrollment and heartbeat only. */
  agent?: EndpointAgentFacts;
};

/** The machine's local hook policy (set by root on the machine, never by the server). */
export type EndpointHookPolicy = "off" | "scripts" | "any";

/** Facts the agent reports in its enrollment and heartbeats. */
export type EndpointAgentFacts = {
  hooks?: EndpointHookPolicy;
  /** Script names in /etc/restow-agent/hooks.d (scripts policy), at most 50. */
  hookScripts?: string[];
  /** When the agent last reported these facts (ISO 8601). */
  reportedAt?: string;
};

/** A machine with an agent enrolled. */
export const endpoints = pgTable(
  "endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    displayName: text("display_name"),
    os: endpointOsEnum("os").notNull(),
    arch: endpointArchEnum("arch").notNull(),
    profile: endpointProfileEnum("profile").notNull(),
    agentVersion: text("agent_version"),
    osVersion: text("os_version"),
    status: endpointStatusEnum("status").notNull().default("active"),
    // SHA-256 (hex) of the agent secret; the secret itself is shown to the agent once.
    secretHash: text("secret_hash").notNull(),
    // The restic repository password, sealed with the tenant key.
    repositorySecretId: uuid("repository_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    config: jsonb("config").$type<EndpointConfig>().notNull(),
    // Bumped by every change of `config`; the agent reports the one it runs.
    configVersion: integer("config_version").notNull().default(1),
    settings: jsonb("settings").$type<EndpointSettings>().notNull().default({}),
    // What the agent reported in its last heartbeat.
    agentState: text("agent_state").$type<"idle" | "running">(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    agentConfigVersion: integer("agent_config_version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // The last finished backup run, whatever its outcome; `last_success_at` only a good one.
    lastBackupAt: timestamp("last_backup_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    // The restic snapshot of the newest good backup.
    lastSnapshotId: text("last_snapshot_id"),
    lastRetentionAt: timestamp("last_retention_at", { withTimezone: true }),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastRestoreTestAt: timestamp("last_restore_test_at", { withTimezone: true }),
    // Set when the "endpoint is silent" alert went out; cleared by the next contact.
    staleAlertedAt: timestamp("stale_alerted_at", { withTimezone: true }),
    // Bytes the repository takes in storage: measured by listing it (retention, first upload
    // after a restart), kept current by every upload in between. Null until first measured.
    repositoryBytes: bigint("repository_bytes", { mode: "number" }),
    repositoryMeasuredAt: timestamp("repository_measured_at", { withTimezone: true }),
    // The last upload refused because the storage budget was used up.
    quotaRefusedAt: timestamp("quota_refused_at", { withTimezone: true }),
    // The storage-budget alert that went out (`near` or `exceeded`) and when; cleared below 80 %.
    quotaAlertLevel: text("quota_alert_level").$type<"near" | "exceeded">(),
    quotaAlertedAt: timestamp("quota_alerted_at", { withTimezone: true }),
    // Retention and check runs in a row that found the repository locked, since when, and
    // when the alert about it went out; reset by the next run that got the lock.
    maintenanceLockedCount: integer("maintenance_locked_count").notNull().default(0),
    maintenanceLockedSince: timestamp("maintenance_locked_since", { withTimezone: true }),
    lockedAlertedAt: timestamp("locked_alerted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("endpoints_tenant_profile_idx").on(t.tenantId, t.profile, t.status),
    index("endpoints_status_seen_idx").on(t.status, t.lastSeenAt),
  ],
);

/**
 * A one-time enrollment token. Only its SHA-256 is stored; it is valid for
 * 24 hours, bound to a tenant and a profile, and single use.
 */
export const endpointEnrollmentTokens = pgTable(
  "endpoint_enrollment_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    profile: endpointProfileEnum("profile").notNull(),
    // A label the admin gave in the wizard; becomes the endpoint's display name.
    displayName: text("display_name"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByEndpointId: uuid("used_by_endpoint_id").references(() => endpoints.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("endpoint_enrollment_tokens_hash_uq").on(t.tokenHash),
    index("endpoint_enrollment_tokens_tenant_idx").on(t.tenantId, t.createdAt),
  ],
);

/** One partial or full error the agent reported for a run. */
export type EndpointRunError = { path?: string; message: string; code?: string };

export type EndpointRunStats = {
  filesNew?: number;
  filesChanged?: number;
  filesUnmodified?: number;
  dataAdded?: number;
  totalFilesProcessed?: number;
  totalBytesProcessed?: number;
};

export type EndpointRunProgress = {
  filesDone: number;
  bytesDone: number;
  totalFiles?: number;
  totalBytes?: number;
  currentPath?: string;
  updatedAt: string;
};

/** A backup, restore or restore-test run the agent reported. */
export const endpointRuns = pgTable(
  "endpoint_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    kind: endpointRunKindEnum("kind").notNull(),
    status: endpointRunStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // The restic snapshot this run made or read.
    snapshotId: text("snapshot_id"),
    stats: jsonb("stats").$type<EndpointRunStats>(),
    errors: jsonb("errors").$type<EndpointRunError[]>().notNull().default([]),
    logTail: text("log_tail"),
    // The structured explanation of what went wrong (packages/core/src/failures), for the web app.
    failure: jsonb("failure").$type<FailureRecordJson>(),
    progress: jsonb("progress").$type<EndpointRunProgress>(),
    taskId: uuid("task_id"),
    // Set when the failure went out as an alert.
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("endpoint_runs_endpoint_started_idx").on(t.endpointId, t.startedAt),
    index("endpoint_runs_tenant_status_idx").on(t.tenantId, t.status),
    // History lists a tenant's runs newest first (apps/api features/history).
    index("endpoint_runs_tenant_created_idx").on(t.tenantId, t.createdAt, t.id),
  ],
);

/** Params of a restore task: into a new folder on the endpoint, never over files. */
export type EndpointRestoreParams = { snapshotId: string; paths: string[]; targetDir?: string };

/** Params of a restore-test task: files and the hashes they must have. */
export type EndpointVerifySampleParams = {
  snapshotId: string;
  files: { path: string; sha256: string }[];
};

/** A job for the agent, delivered with its next heartbeat. */
export const endpointTasks = pgTable(
  "endpoint_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    kind: endpointTaskKindEnum("kind").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    status: endpointTaskStatusEnum("status").notNull().default("pending"),
    // better-auth user id of the admin; null for tasks the server created itself.
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // A task nobody picked up by then is failed (a laptop that stayed off).
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Why a task failed or expired; never a secret.
    errorMessage: text("error_message"),
  },
  (t) => [
    index("endpoint_tasks_endpoint_status_idx").on(t.endpointId, t.status),
    index("endpoint_tasks_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

/** A file the agent hashed after a backup: the reference for a restore test. */
export const endpointSamples = pgTable(
  "endpoint_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => endpointRuns.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull(),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("endpoint_samples_run_path_uq").on(t.runId, t.path),
    index("endpoint_samples_endpoint_snapshot_idx").on(t.endpointId, t.snapshotId),
  ],
);

/** Where a restore-test report came from: the server reading the repository, or the agent. */
export type EndpointReportOrigin = "server" | "agent";

export type EndpointReportSummary = {
  // restore_test
  files?: number;
  matched?: number;
  mismatched?: { path: string; expected: string; actual: string | null; reason?: string }[];
  // repository_check
  subsetPercent?: number;
  // retention
  removedSnapshots?: number;
  keptSnapshots?: number;
  repositoryBytes?: number;
  /** Snapshots retention left alone because the server has no run that reported them. */
  unrecordedSnapshots?: number;
  /** Snapshots whose recorded time lies in the future or after their file was stored. */
  futureSnapshots?: number;
  /** Agent lock files removed before the run (no backup of the agent was running). */
  removedLocks?: number;
  // any failed step
  errorMessage?: string;
  [key: string]: unknown;
};

/**
 * What the server found out about an endpoint's repository: the outcome of a
 * restore test (which rates a snapshot like `verify_reports` rates a mailbox
 * backup), a repository check and a retention run. `readiness` is null for a
 * retention run, which only reports.
 */
export const endpointReports = pgTable(
  "endpoint_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    kind: endpointReportKindEnum("kind").notNull(),
    origin: text("origin").$type<EndpointReportOrigin>().notNull().default("server"),
    // The restic snapshot a restore test read back; null for checks and retention.
    snapshotId: text("snapshot_id"),
    readiness: recoveryReadinessEnum("readiness"),
    summary: jsonb("summary").$type<EndpointReportSummary>().notNull().default({}),
    runId: uuid("run_id"),
    // Set when a red report went out as an alert.
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("endpoint_reports_endpoint_checked_idx").on(t.endpointId, t.checkedAt),
    index("endpoint_reports_tenant_kind_idx").on(t.tenantId, t.kind),
    // Which restore tests of a machine a report rated (History groups the ones that were not).
    index("endpoint_reports_run_idx").on(t.runId),
  ],
);

/**
 * A lock file the agent wrote into its repository (`locks/<name>`). The agent
 * may delete only the locks recorded here, so it can release its own locks but
 * never the server's (docs/AGENT.md, "Sperren"); the server removes the ones
 * left over before its own maintenance when no run of the agent is active.
 */
export const endpointRepositoryLocks = pgTable(
  "endpoint_repository_locks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    // The object name (SHA-256 hex of the lock file's content).
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("endpoint_repository_locks_endpoint_name_uq").on(t.endpointId, t.name)],
);

/**
 * Why a snapshot in an endpoint's repository is suspicious: the server has no
 * run that reported it (`unrecorded`), or its time, which the agent chooses,
 * lies in the future or after the moment its file was stored (`future_time`).
 */
export type EndpointSnapshotFlagReason = "unrecorded" | "future_time";

/**
 * A snapshot the retention run found suspicious (docs/AGENT.md,
 * "Aufbewahrung"). Retention never lets such a snapshot's own time decide
 * anything and never deletes an unrecorded one; the row remembers that the
 * admin was told, so each snapshot is announced once.
 */
export const endpointSnapshotFlags = pgTable(
  "endpoint_snapshot_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull(),
    reasons: jsonb("reasons").$type<EndpointSnapshotFlagReason[]>().notNull(),
    // The time restic records in the snapshot (chosen by the agent) and when its file was stored.
    snapshotTime: timestamp("snapshot_time", { withTimezone: true }),
    storedAt: timestamp("stored_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when the alert about this snapshot went out.
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("endpoint_snapshot_flags_endpoint_snapshot_uq").on(t.endpointId, t.snapshotId),
    index("endpoint_snapshot_flags_tenant_idx").on(t.tenantId, t.createdAt),
  ],
);

/** One file or folder of a prepared ZIP download, as resolved in the snapshot. */
export type EndpointDownloadItem = { path: string; type: "file" | "dir" };

/**
 * A ZIP download of snapshot files, prepared by `POST .../downloads` and
 * streamed once by `GET .../downloads/:id` (docs/AGENT.md, "Restore"). The
 * selection is checked against the snapshot when it is prepared and kept here,
 * so the request carries no paths in a URL; the row is bound to the admin who
 * asked, expires after a few minutes and can be started exactly once. Expired
 * rows are removed by the endpoint monitor.
 */
export const endpointDownloads = pgTable(
  "endpoint_downloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").notNull(),
    selection: jsonb("selection").$type<EndpointDownloadItem[]>().notNull(),
    // better-auth user id of the admin who prepared it; only that admin can fetch it.
    createdBy: text("created_by").references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set by the request that started the download; a second one finds it gone.
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (t) => [
    index("endpoint_downloads_endpoint_idx").on(t.endpointId),
    index("endpoint_downloads_expires_idx").on(t.expiresAt),
  ],
);

export type Endpoint = typeof endpoints.$inferSelect;
export type NewEndpoint = typeof endpoints.$inferInsert;
export type EndpointEnrollmentToken = typeof endpointEnrollmentTokens.$inferSelect;
export type NewEndpointEnrollmentToken = typeof endpointEnrollmentTokens.$inferInsert;
export type EndpointRun = typeof endpointRuns.$inferSelect;
export type NewEndpointRun = typeof endpointRuns.$inferInsert;
export type EndpointTask = typeof endpointTasks.$inferSelect;
export type NewEndpointTask = typeof endpointTasks.$inferInsert;
export type EndpointSample = typeof endpointSamples.$inferSelect;
export type NewEndpointSample = typeof endpointSamples.$inferInsert;
export type EndpointReport = typeof endpointReports.$inferSelect;
export type NewEndpointReport = typeof endpointReports.$inferInsert;
export type EndpointRepositoryLock = typeof endpointRepositoryLocks.$inferSelect;
export type NewEndpointRepositoryLock = typeof endpointRepositoryLocks.$inferInsert;
export type EndpointSnapshotFlag = typeof endpointSnapshotFlags.$inferSelect;
export type NewEndpointSnapshotFlag = typeof endpointSnapshotFlags.$inferInsert;
export type EndpointDownload = typeof endpointDownloads.$inferSelect;
export type NewEndpointDownload = typeof endpointDownloads.$inferInsert;
