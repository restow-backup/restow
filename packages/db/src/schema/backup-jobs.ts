import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { retentionPolicies } from "./archive.js";
import { user } from "./auth.js";
import { type EndpointBandwidthWindow, type EndpointRetention, endpoints } from "./endpoints.js";
import { fileShares } from "./file-shares.js";
import { protectedObjects } from "./sources.js";
import { storageTargets } from "./storage.js";
import { tenants } from "./tenants.js";

/**
 * Backup jobs: what is backed up, when, where and for how long, as one
 * definition over many objects (release 0.2.0, docs/ARCHITECTURE.md "Jobs").
 *
 * A job is a template. A `mail` job covers protected objects (mailboxes,
 * OneDrives, IMAP mailboxes); the scheduler plans its backups and restore
 * checks. An `endpoint` job covers machines with an agent; it is not planned
 * by the scheduler, the agent runs on its own. Instead the effective
 * configuration (the job plus the machine's override) is written into
 * `endpoints.config` whenever the job or its scope changes, so the agent keeps
 * reading the configuration it always read (`GET /agent/v1/config`).
 *
 * A `share` job covers file shares (docs/FILESHARES.md 7.5): the scheduler plans their backups
 * and the worker's dispatcher starts the runs. A `copy` job copies the newest verified restore
 * point of one share into a folder of another (4.10); its two shares are columns of the job
 * (`source_file_share_id`, `target_file_share_id`), it has no member rows.
 *
 * The things that are not part of a job stay in `schedules`: retention run,
 * storage check (scrub), directory sync and archive sync.
 */

export const backupJobKindEnum = pgEnum("backup_job_kind", ["mail", "endpoint", "share", "copy"]);

/**
 * `selected`: the job covers exactly its member rows. `all`: it covers every
 * protected object of the tenant that is not a member of another job (and
 * the objects added later), the member rows only carry overrides. At most one
 * `all` job per tenant and kind (`backup_jobs_tenant_kind_all_uq`); endpoint
 * jobs are always `selected`.
 */
export const backupJobScopeEnum = pgEnum("backup_job_scope", ["all", "selected"]);

/** Where a job came from: an administrator, or the migration of the schedules of an older release. */
export type BackupJobOrigin = "user" | "migration";

/**
 * When a job (or one member) runs. Mail jobs: `interval` or `cron` (`daily`
 * is stored as the equivalent cron expression by the API); endpoint jobs:
 * `interval`, `daily` or `on_connect`, exactly what the agent contract knows
 * (EndpointSchedule). `timeZone` is the IANA zone cron and `timeOfDay` are read in.
 */
export type BackupJobSchedule = {
  kind: "interval" | "cron" | "daily" | "on_connect";
  /** `interval`: minutes between runs; `on_connect`: the least minutes between two backups. */
  intervalMinutes?: number;
  /** `cron`: five fields. */
  cron?: string;
  /** `daily`: local time `HH:MM`. */
  timeOfDay?: string;
  timeZone: string;
};

/** What an endpoint job tells the agent to back up and how; every field falls back to what the machine has. */
export type BackupJobEndpointSettings = {
  paths?: string[];
  /** Exclude patterns (restic `--exclude-file` lines), exactly as sent to the agent. */
  excludes?: string[];
  /** Skip files larger than this many GiB (restic `--exclude-larger-than`); null or absent = no limit. */
  excludeLargerThanGib?: number | null;
  hooks?: { pre?: string; post?: string };
  /**
   * Upload limit in kbit/s, the default outside every window. `0` (machine jobs): unlimited even
   * when the agent policy sets a limit; null or absent: the policy's limit, else unlimited.
   */
  bandwidthKbps?: number | null;
  /** Time windows with a limit of their own, read in the job schedule's zone; absent or empty = none. */
  bandwidthWindows?: EndpointBandwidthWindow[];
  /** Server-side retention of the machine's repository (`restic forget --keep-*`). */
  retention?: EndpointRetention;
  /**
   * The job's level of the agent policy (@restow/core endpoints/agent-policy.ts): backup window,
   * catching up missed backups, AC power, retries; a key left out inherits from the tenant and
   * the installation. Not overridable per member.
   */
  policy?: BackupJobAgentPolicy;
};

/** A weekly range in which agents may start backups (days start it, 1 = Monday ... 7 = Sunday). */
export type AgentPolicyBackupWindow = { days: number[]; from: string; to: string };

/** Catching up a backup missed while the machine was off or asleep. */
export type AgentPolicyCatchUp = {
  enabled: boolean;
  mode: "asap" | "next_window";
  maxAgeHours: number | null;
};

/** One level of the agent policy: a key that is present is set at this level. */
export type AgentPolicyLevel = {
  backupWindow?: AgentPolicyBackupWindow | null;
  catchUp?: AgentPolicyCatchUp;
  bandwidthKbps?: number | null;
  onlyOnAcPower?: boolean;
  retries?: number;
  /** What a backup does when its file system snapshot fails (0.5.0); absent inherits, default continue. */
  snapshotOnFailure?: "continue" | "fail";
};

/** The job's level of the agent policy (its upload limit is the job's own field). */
export type BackupJobAgentPolicy = Omit<AgentPolicyLevel, "bandwidthKbps">;

/** The installation's agent policy: its settings, and the ones no tenant or job may change. */
export type GlobalAgentPolicyRecord = {
  settings?: AgentPolicyLevel;
  locks?: (
    | "backupWindow"
    | "catchUp"
    | "bandwidthKbps"
    | "onlyOnAcPower"
    | "retries"
    | "snapshotOnFailure"
  )[];
};

/** What a file share job does (docs/FILESHARES.md 7.5); every field has a documented default. */
export type BackupJobShareSettings = {
  /** Exclude patterns, one per line, restic syntax. */
  excludes?: string[];
  /** "Skip temporary and system files" (default true). */
  presets?: { systemFiles?: boolean };
  /** File extensions to skip, without the dot. */
  fileTypes?: { exclude: string[] };
  excludeLargerThanGib?: number | null;
  bandwidthKbps?: number | null;
  bandwidthWindows?: EndpointBandwidthWindow[];
  /** restic's read concurrency; default the installation's. */
  readConcurrency?: number;
  /** Skip offline (tiered) files instead of recalling them (default true). */
  skipOffline?: boolean;
  /** Default 30 daily, 12 weekly, 12 monthly. */
  retention?: EndpointRetention;
};

/** What a copy job does (docs/FILESHARES.md 4.10, 7.5). */
export type BackupJobCopySettings = {
  /** Relative to the target share's root; never "" for `mirror`. */
  targetFolder: string;
  mode: "overwrite" | "mirror";
  /** Default false. */
  restorePermissions?: boolean;
  /** ISO; set when the admin confirmed a non-empty folder without a marker. */
  mirrorConfirmedAt?: string | null;
  /** restic --verify; default as for restores (on for NFS targets). */
  verify?: boolean;
};

/**
 * How a mail job's archive captures the mail of its objects (docs/ARCHIVE.md
 * "Erfassungswege", 0.4.4), per kind of mail object (`captureKind`, packages/db
 * archive-capture.ts): Microsoft 365 mailboxes by Graph and/or Exchange journaling, IMAP
 * accounts (Google Workspace among them) by IMAP sync and/or a provider's forwarded copy.
 * A kind the job has no objects of may be absent; a kind it has needs at least one way
 * while the job archives (the API checks it), unless it carries `pending`: a job that archived
 * before 0.4.4 had no IMAP capture, and the update (migration 0062) left its IMAP and Google
 * accounts without a way until an administrator chooses one. Only that migration sets the
 * marker; the API keeps it while the kind still has no way and drops it once one is chosen.
 * Ignored while `archive` is false.
 */
export type ArchiveCaptureSettings = {
  m365?: { graph: boolean; journal: boolean };
  imap?: ImapCaptureWays;
  google?: ImapCaptureWays;
};

/** The ways of IMAP accounts (and Google Workspace) in {@link ArchiveCaptureSettings}. */
export type ImapCaptureWays = {
  sync: boolean;
  forward: boolean;
  /** No way chosen yet since the update to 0.4.4 (see {@link ArchiveCaptureSettings}). */
  pending?: true;
};

/**
 * The settings of a job: mail jobs carry none, endpoint, share and copy jobs their own kind's
 * (a reader looks at the job's `kind` first).
 */
export type BackupJobSettings = BackupJobEndpointSettings &
  BackupJobShareSettings &
  Partial<BackupJobCopySettings>;

/** What one member does differently from the job; a field set here replaces the job's value. */
export type BackupJobMemberOverrides = BackupJobEndpointSettings &
  BackupJobShareSettings & {
    /** Its own backup schedule (mail: planned per object; endpoint: written to the machine). */
    schedule?: BackupJobSchedule;
    /** Mail: its own restore-check schedule. */
    verifySchedule?: BackupJobSchedule;
    /** File shares: folders relative to the share root; empty = everything. */
    includes?: string[];
  };

/**
 * A backup job of a tenant. The runtime columns (`next_run_at`,
 * `last_run_at`, `verify_*`) belong to the scheduler and are used by mail
 * jobs only. `schedule` is null for a job that is run by hand only, and for a
 * mail job `verify_schedule` null means no restore checks (an endpoint job's
 * restore checks follow every backup, whatever the job says).
 */
export const backupJobs = pgTable(
  "backup_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: backupJobKindEnum("kind").notNull(),
    name: text("name").notNull(),
    scopeMode: backupJobScopeEnum("scope_mode").notNull().default("selected"),
    schedule: jsonb("schedule").$type<BackupJobSchedule>(),
    verifySchedule: jsonb("verify_schedule").$type<BackupJobSchedule>(),
    // The repository: null = the tenant's primary storage target (the only one written to).
    storageTargetId: uuid("storage_target_id").references(() => storageTargets.id, {
      onDelete: "set null",
    }),
    // Mail: the snapshot retention policy; null = the tenant's default policy.
    retentionPolicyId: uuid("retention_policy_id").references(() => retentionPolicies.id, {
      onDelete: "set null",
    }),
    settings: jsonb("settings").$type<BackupJobSettings>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Mail jobs: the job's mailboxes are archived through journaling (docs/ARCHIVE.md).
     * Capture never depends on it: the journal receiver archives every report it gets
     * and assigns it to the mailboxes it names. The flag says which mailboxes the
     * operator expects in the archive, so the job can show and check their capture.
     * Always false for endpoint jobs.
     */
    archive: boolean("archive").notNull().default(false),
    /**
     * Mail jobs with `archive`: the capture ways per kind of mail object
     * ({@link ArchiveCaptureSettings}); `{}` = the defaults (Graph for Microsoft 365, IMAP
     * sync for IMAP). The worker's capture service keeps a stream per object and mailbox way
     * chosen here (apps/worker/src/archive-capture/reconcile.ts).
     */
    archiveCapture: jsonb("archive_capture").$type<ArchiveCaptureSettings>().notNull().default({}),
    origin: text("origin").$type<BackupJobOrigin>().notNull().default("user"),
    /**
     * The job Restow recommended and made with one click (#52): `mail`, or `endpoint:<os>:<profile>`
     * for the machines of one system and profile. One per tenant and key (the partial unique index),
     * so a second click adds to that job instead of making another. Null for every job an
     * administrator set up in the editor; it stays when the job is edited afterwards.
     */
    recommended: text("recommended"),
    // A copy job's two shares (docs/FILESHARES.md 7.2); null for every other kind.
    sourceFileShareId: uuid("source_file_share_id").references(() => fileShares.id, {
      onDelete: "cascade",
    }),
    targetFileShareId: uuid("target_file_share_id").references(() => fileShares.id, {
      onDelete: "cascade",
    }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    verifyNextRunAt: timestamp("verify_next_run_at", { withTimezone: true }),
    verifyLastRunAt: timestamp("verify_last_run_at", { withTimezone: true }),
    // better-auth user id of the administrator who created it; null for the migration.
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("backup_jobs_tenant_kind_idx").on(t.tenantId, t.kind),
    index("backup_jobs_due_idx").on(t.kind, t.enabled, t.nextRunAt),
    uniqueIndex("backup_jobs_tenant_kind_name_uq").on(t.tenantId, t.kind, sql`lower(${t.name})`),
    uniqueIndex("backup_jobs_tenant_kind_all_uq")
      .on(t.tenantId, t.kind)
      .where(sql`${t.scopeMode} = 'all'`),
    uniqueIndex("backup_jobs_tenant_recommended_uq")
      .on(t.tenantId, t.recommended)
      .where(sql`${t.recommended} IS NOT NULL`),
    // A copy job has both shares, every other job neither. `kind::text`: the migration that adds
    // this check runs in the transaction that may have just added the enum value 'copy', and a new
    // enum value cannot be used as such before that transaction commits (0036, 0037).
    check(
      "backup_jobs_copy_shares_ck",
      sql`CASE WHEN ${t.kind}::text = 'copy' THEN ${t.sourceFileShareId} IS NOT NULL AND ${t.targetFileShareId} IS NOT NULL ELSE ${t.sourceFileShareId} IS NULL AND ${t.targetFileShareId} IS NULL END`,
    ),
    check("backup_jobs_copy_distinct_ck", sql`${t.sourceFileShareId} <> ${t.targetFileShareId}`),
  ],
);

/**
 * One member of a job: a protected object (mail jobs), a machine (endpoint
 * jobs) or a file share (share jobs), with what it does differently. An object or machine belongs to at
 * most one job (the two partial unique indexes). `next_run_at` and
 * friends are only used while `overrides` carries a schedule of its own.
 */
export const backupJobMembers = pgTable(
  "backup_job_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => backupJobs.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id").references(() => protectedObjects.id, {
      onDelete: "cascade",
    }),
    endpointId: uuid("endpoint_id").references(() => endpoints.id, { onDelete: "cascade" }),
    fileShareId: uuid("file_share_id").references(() => fileShares.id, { onDelete: "cascade" }),
    overrides: jsonb("overrides").$type<BackupJobMemberOverrides>().notNull().default({}),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    verifyNextRunAt: timestamp("verify_next_run_at", { withTimezone: true }),
    verifyLastRunAt: timestamp("verify_last_run_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("backup_job_members_job_idx").on(t.jobId),
    index("backup_job_members_tenant_idx").on(t.tenantId),
    uniqueIndex("backup_job_members_object_uq")
      .on(t.protectedObjectId)
      .where(sql`${t.protectedObjectId} IS NOT NULL`),
    uniqueIndex("backup_job_members_endpoint_uq")
      .on(t.endpointId)
      .where(sql`${t.endpointId} IS NOT NULL`),
    uniqueIndex("backup_job_members_file_share_uq")
      .on(t.fileShareId)
      .where(sql`${t.fileShareId} IS NOT NULL`),
    check(
      "backup_job_members_one_target_ck",
      sql`num_nonnulls(${t.protectedObjectId}, ${t.endpointId}, ${t.fileShareId}) = 1`,
    ),
  ],
);

export type BackupJob = typeof backupJobs.$inferSelect;
export type NewBackupJob = typeof backupJobs.$inferInsert;
export type BackupJobMember = typeof backupJobMembers.$inferSelect;
export type NewBackupJobMember = typeof backupJobMembers.$inferInsert;
export type BackupJobKind = (typeof backupJobKindEnum.enumValues)[number];
export type BackupJobScope = (typeof backupJobScopeEnum.enumValues)[number];
