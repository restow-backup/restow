import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { type FailureRecordJson, timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { backupJobs } from "./backup-jobs.js";
import { recoveryReadinessEnum } from "./jobs.js";
import { secrets } from "./secrets.js";
import { tenants } from "./tenants.js";

/**
 * File shares (docs/FILESHARES.md section 7): SMB shares and NFS exports Restow backs up from
 * the server side. The mounter mounts a share for one run into a short-lived runner container
 * (`restow-share`), which writes into one restic repository per share under
 * `file-shares/<share id>/` of the tenant's primary storage target. Every table here is
 * tenant-scoped (RLS, sql/rls.sql). State and kind columns are text with a TypeScript union
 * (like pve.ts), so a new value never needs `ALTER TYPE`.
 */

export type FileShareProtocol = "smb" | "nfs";
export type FileShareSmbVersion = "3.1.1" | "3.0" | "2.1";
export type FileShareNfsVersion = "3" | "4" | "4.1" | "4.2";
export type FileSharePermissionsMode = "auto" | "off";
export type FileShareRunKind = "backup" | "restore";
/** `queued` is "waiting" in the glossary. `starting` and `running` hold the run credential. */
export type FileShareRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "warning"
  | "failed"
  | "cancelled";
/** `copy`: a run of a scheduled copy job (4.10). */
export type FileShareRunTrigger = "schedule" | "manual" | "retry" | "copy";

/**
 * A provider admin's approval of a share on a loopback or private address (10.1): who, when,
 * the address they approved and the range it covers (its /24 or /64).
 */
export type FileSharePrivateNetworkApproval = {
  by: string;
  at: string;
  address: string;
  range: string;
};

/** The last connection test of a share. */
export type FileShareLastTest = {
  ok: boolean;
  code: string | null;
  at: string;
  durationMs: number;
};

/** A restore (4.7) or copy (4.10) run's parameters, and the overrides of a manual backup. */
export type FileShareRunParams = {
  // restore
  snapshotId?: string;
  paths?: string[];
  destination?: "original" | "new_folder" | "folder";
  folder?: string;
  conflict?: "overwrite" | "keep_both" | "skip";
  restorePermissions?: boolean;
  verify?: boolean;
  // copy
  mode?: "overwrite" | "mirror";
  targetFolder?: string;
  mirrorConfirmedAt?: string | null;
  force?: boolean;
  // backup
  allowEmptyOnce?: boolean;
  /** The include folders the session handed the runner (the restore point's `includes`). */
  includes?: string[];
  /** A run that ended at once (a copy that was up to date, a refusal before the runner). */
  note?: string;
  [key: string]: unknown;
};

/** The last progress report of a running run (5.2). */
export type FileShareRunProgress = {
  phase: string;
  filesDone: number;
  bytesDone: number;
  totalFiles: number;
  totalBytes: number;
  currentPath: string;
  bytesUploaded: number;
  at: string;
};

/** The finish statistics of a run (restow-share's `stats`, plus `restore` for a restore). */
export type FileShareRunStats = {
  files?: number;
  dirs?: number;
  bytes?: number;
  dataAdded?: number;
  /** The restic snapshot a backup created (as the runner reported it). */
  resticSnapshotId?: string;
  items?: Record<string, number>;
  restore?: Record<string, unknown>;
  upToDate?: boolean;
  [key: string]: unknown;
};

/** The permissions summary of a restore point (sidecar counts). */
export type FileShareSnapshotPermissions = {
  mode: string;
  xattr: string;
  entries: number;
  descriptors: number;
  errors: number;
};

/** A share. */
export const fileShares = pgTable(
  "file_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    protocol: text("protocol").$type<FileShareProtocol>().notNull(),
    // Host name or IP as entered (normalised).
    server: text("server").notNull(),
    shareName: text("share_name"),
    exportPath: text("export_path"),
    subfolder: text("subfolder").notNull().default(""),
    smbVersion: text("smb_version").$type<FileShareSmbVersion>(),
    smbEncryption: boolean("smb_encryption").notNull().default(false),
    smbDomain: text("smb_domain"),
    username: text("username"),
    // The SMB password, sealed with the tenant key (kind `file_share_password`).
    credentialSecretId: uuid("credential_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    nfsVersion: text("nfs_version").$type<FileShareNfsVersion>(),
    allowRestore: boolean("allow_restore").notNull().default(false),
    permissionsMode: text("permissions_mode")
      .$type<FileSharePermissionsMode>()
      .notNull()
      .default("auto"),
    rereadPermissions: boolean("reread_permissions").notNull().default(false),
    privateNetworkApproval: jsonb(
      "private_network_approval",
    ).$type<FileSharePrivateNetworkApproval>(),
    // The restic repository password (kind `file_share_repository`).
    repositorySecretId: uuid("repository_secret_id").references(() => secrets.id, {
      onDelete: "set null",
    }),
    repositoryReadyAt: timestamp("repository_ready_at", { withTimezone: true }),
    repositoryBytes: bigint("repository_bytes", { mode: "number" }),
    repositoryMeasuredAt: timestamp("repository_measured_at", { withTimezone: true }),
    // The share's storage budget in GiB; null = none (7.4).
    quotaGib: integer("quota_gib"),
    quotaAlertLevel: text("quota_alert_level").$type<"near" | "exceeded">(),
    quotaAlertedAt: timestamp("quota_alerted_at", { withTimezone: true }),
    quotaRefusedAt: timestamp("quota_refused_at", { withTimezone: true }),
    lastTest: jsonb("last_test").$type<FileShareLastTest>(),
    // Set by a `share.auth_failed` run or test, cleared by a success.
    credentialFailedAt: timestamp("credential_failed_at", { withTimezone: true }),
    lastBackupAt: timestamp("last_backup_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    // file_share_snapshots.id of the newest good restore point.
    lastSnapshotId: uuid("last_snapshot_id"),
    lastRetentionAt: timestamp("last_retention_at", { withTimezone: true }),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastRestoreTestAt: timestamp("last_restore_test_at", { withTimezone: true }),
    lastCatalogAt: timestamp("last_catalog_at", { withTimezone: true }),
    maintenanceLockedCount: integer("maintenance_locked_count").notNull().default(0),
    maintenanceLockedSince: timestamp("maintenance_locked_since", { withTimezone: true }),
    lockedAlertedAt: timestamp("locked_alerted_at", { withTimezone: true }),
    // The next backup may find the share empty (4.3).
    allowEmptyOnce: boolean("allow_empty_once").notNull().default(false),
    // Removed from protection; backups kept.
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("file_shares_tenant_idx").on(t.tenantId),
    uniqueIndex("file_shares_tenant_name_uq")
      .on(t.tenantId, sql`lower(${t.name})`)
      .where(sql`${t.retiredAt} IS NULL`),
    index("file_shares_tenant_retired_idx").on(t.tenantId, t.retiredAt),
  ],
);

/** A backup or restore run of a share (the runner's `runId` is the row's id). */
export const fileShareRuns = pgTable(
  "file_share_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // The share backed up, or the source of a restore.
    fileShareId: uuid("file_share_id")
      .notNull()
      .references(() => fileShares.id, { onDelete: "cascade" }),
    kind: text("kind").$type<FileShareRunKind>().notNull(),
    status: text("status").$type<FileShareRunStatus>().notNull().default("queued"),
    trigger: text("trigger").$type<FileShareRunTrigger>().notNull().default("manual"),
    backupJobId: uuid("backup_job_id").references(() => backupJobs.id, { onDelete: "set null" }),
    // The share whose mount the run holds: the share itself for a backup, the target of a restore.
    lockShareId: uuid("lock_share_id")
      .notNull()
      .references(() => fileShares.id, { onDelete: "cascade" }),
    targetShareId: uuid("target_share_id").references(() => fileShares.id, {
      onDelete: "set null",
    }),
    sourceSnapshotId: uuid("source_snapshot_id").references(() => fileShareSnapshots.id, {
      onDelete: "set null",
    }),
    params: jsonb("params").$type<FileShareRunParams>().notNull().default({}),
    // The run credential (5.1): SHA-256 only, valid until the deadline.
    tokenHash: text("token_hash"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
    // When the worker processed the finish (snapshot row, share columns, alerts): the api
    // records the finish, the worker does the heavy part once (8.3).
    finishProcessedAt: timestamp("finish_processed_at", { withTimezone: true }),
    progress: jsonb("progress").$type<FileShareRunProgress>(),
    stats: jsonb("stats").$type<FileShareRunStats>().notNull().default({}),
    // file_share_snapshots.id of the restore point a backup created.
    snapshotId: uuid("snapshot_id"),
    itemCount: integer("item_count").notNull().default(0),
    itemsStored: integer("items_stored").notNull().default(0),
    failure: jsonb("failure").$type<FailureRecordJson>(),
    errorMessage: text("error_message"),
    logTail: text("log_tail"),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("file_share_runs_share_created_idx").on(t.fileShareId, t.createdAt),
    index("file_share_runs_tenant_created_idx").on(t.tenantId, t.createdAt, t.id),
    index("file_share_runs_status_queued_idx").on(t.status, t.queuedAt),
    // One run per share mount at a time (the dispatcher's singleton, 8.2).
    uniqueIndex("file_share_runs_lock_active_uq")
      .on(t.lockShareId)
      .where(sql`${t.status} IN ('starting', 'running')`),
    // A share does not collect queued backups while one is late.
    uniqueIndex("file_share_runs_backup_queued_uq")
      .on(t.fileShareId)
      .where(sql`${t.kind} = 'backup' AND ${t.status} = 'queued'`),
  ],
);

/** A per-file problem of a run (5.2 items); at most 10,000 per run are stored. */
export const fileShareRunItems = pgTable(
  "file_share_run_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => fileShareRuns.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    code: text("code").notNull(),
    phase: text("phase").notNull(),
    message: text("message").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("file_share_run_items_run_code_idx").on(t.runId, t.code)],
);

/** A restore point ("Sicherungsstand") of a share: one restic snapshot of its repository. */
export const fileShareSnapshots = pgTable(
  "file_share_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fileShareId: uuid("file_share_id")
      .notNull()
      .references(() => fileShares.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    // Per share, increasing.
    sequence: integer("sequence").notNull(),
    resticSnapshotId: text("restic_snapshot_id").notNull(),
    snapshotTime: timestamp("snapshot_time", { withTimezone: true }).notNull(),
    includes: jsonb("includes").$type<string[]>().notNull().default([]),
    files: bigint("files", { mode: "number" }).notNull().default(0),
    dirs: bigint("dirs", { mode: "number" }).notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    bytesAdded: bigint("bytes_added", { mode: "number" }).notNull().default(0),
    permissions: jsonb("permissions").$type<FileShareSnapshotPermissions>(),
    status: text("status").$type<"active" | "pruned">().notNull().default("active"),
    prunedAt: timestamp("pruned_at", { withTimezone: true }),
    // When its versions went into the catalog (8.5); null while not catalogued.
    catalogedAt: timestamp("cataloged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("file_share_snapshots_share_sequence_uq").on(t.fileShareId, t.sequence),
    uniqueIndex("file_share_snapshots_share_restic_uq").on(t.fileShareId, t.resticSnapshotId),
    index("file_share_snapshots_tenant_idx").on(t.tenantId),
  ],
);

/** A file the runner hashed after a backup: the reference of the restore check (8.4). */
export const fileShareSamples = pgTable(
  "file_share_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fileShareId: uuid("file_share_id")
      .notNull()
      .references(() => fileShares.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => fileShareRuns.id, { onDelete: "cascade" }),
    // The restic snapshot id.
    snapshotId: text("snapshot_id").notNull(),
    // The path in the snapshot (`/share/...`).
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("file_share_samples_run_path_uq").on(t.runId, t.path),
    index("file_share_samples_share_snapshot_idx").on(t.fileShareId, t.snapshotId),
  ],
);

export type FileShareReportSummary = {
  files?: number;
  matched?: number;
  mismatched?: { path: string; expected: string; actual: string | null; reason?: string }[];
  subset?: string;
  removedSnapshots?: number;
  keptSnapshots?: number;
  repositoryBytes?: number;
  unrecordedSnapshots?: number;
  futureSnapshots?: number;
  removedLocks?: number;
  errorMessage?: string;
  [key: string]: unknown;
};

/** What the server found out about a share's repository (as endpoint_reports). */
export const fileShareReports = pgTable(
  "file_share_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fileShareId: uuid("file_share_id")
      .notNull()
      .references(() => fileShares.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"restore_test" | "repository_check" | "retention">().notNull(),
    readiness: recoveryReadinessEnum("readiness"),
    // The restic snapshot id a restore check read back.
    snapshotId: text("snapshot_id"),
    summary: jsonb("summary").$type<FileShareReportSummary>().notNull().default({}),
    runId: uuid("run_id"),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("file_share_reports_share_checked_idx").on(t.fileShareId, t.checkedAt),
    index("file_share_reports_tenant_kind_idx").on(t.tenantId, t.kind),
  ],
);

/** A lock file a backup runner wrote into its repository (as endpoint_repository_locks). */
export const fileShareRepositoryLocks = pgTable(
  "file_share_repository_locks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fileShareId: uuid("file_share_id")
      .notNull()
      .references(() => fileShares.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("file_share_repository_locks_share_name_uq").on(t.fileShareId, t.name)],
);

/** One file or folder of a prepared ZIP download. */
export type FileShareDownloadItem = { path: string; type: "file" | "dir" };

/** A ZIP download of restore point files (as endpoint_downloads). */
export const fileShareDownloads = pgTable(
  "file_share_downloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fileShareId: uuid("file_share_id")
      .notNull()
      .references(() => fileShares.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => fileShareSnapshots.id, { onDelete: "cascade" }),
    selection: jsonb("selection").$type<FileShareDownloadItem[]>().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (t) => [
    index("file_share_downloads_share_idx").on(t.fileShareId),
    index("file_share_downloads_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Search and version history (8.5): one row per version of a file, valid from restore point
 * `first_seq` up to (not including) `end_seq`; null = still present. Migration 0033 adds a
 * trigram index on lower(name) where pg_trgm is available.
 */
export const fileShareCatalog = pgTable(
  "file_share_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fileShareId: uuid("file_share_id")
      .notNull()
      .references(() => fileShares.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    mtime: timestamp("mtime", { withTimezone: true }),
    firstSeq: integer("first_seq").notNull(),
    endSeq: integer("end_seq"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One version per path and first restore point (the natural key; `id` is the convention).
    uniqueIndex("file_share_catalog_version_uq").on(t.fileShareId, t.path, t.firstSeq),
    // Open versions per share: what the next diff closes.
    index("file_share_catalog_open_idx").on(t.fileShareId, t.endSeq),
    index("file_share_catalog_name_idx").on(t.fileShareId, sql`lower(${t.name}) text_pattern_ops`),
  ],
);

export type FileShare = typeof fileShares.$inferSelect;
export type NewFileShare = typeof fileShares.$inferInsert;
export type FileShareRun = typeof fileShareRuns.$inferSelect;
export type NewFileShareRun = typeof fileShareRuns.$inferInsert;
export type FileShareRunItem = typeof fileShareRunItems.$inferSelect;
export type FileShareSnapshot = typeof fileShareSnapshots.$inferSelect;
export type NewFileShareSnapshot = typeof fileShareSnapshots.$inferInsert;
export type FileShareSample = typeof fileShareSamples.$inferSelect;
export type FileShareReport = typeof fileShareReports.$inferSelect;
export type NewFileShareReport = typeof fileShareReports.$inferInsert;
export type FileShareRepositoryLock = typeof fileShareRepositoryLocks.$inferSelect;
export type FileShareDownload = typeof fileShareDownloads.$inferSelect;
export type FileShareCatalogEntry = typeof fileShareCatalog.$inferSelect;
