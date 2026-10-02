import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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

export type { FailureRecordJson } from "./_shared.js";
import { user } from "./auth.js";
import { snapshots } from "./backup.js";
import { protectedObjects } from "./sources.js";
import { tenants } from "./tenants.js";

/**
 * pg-boss queues (see docs/ARCHITECTURE.md, Job-System).
 *
 * `storage_migration` was added to this enum by an `ALTER TYPE ... ADD VALUE`
 * migration, so no migration in the same file may use it (in DDL, defaults,
 * partial-index predicates or a backfill) — Postgres refuses that as an unsafe
 * use of a new enum value. A later migration that needs it is safe; test it
 * against a fresh install, not only an upgrade.
 */
export const jobQueueEnum = pgEnum("job_queue", [
  "backup",
  "restore",
  "verify",
  "archive",
  "directory",
  "retention",
  "scrub",
  // Moves a tenant's backups from one storage target to another (see
  // packages/db/src/schema/storage.ts storageMigrations). Registered here so
  // the queue exists end to end; the worker handler ships separately, like
  // `archive` did before its handler existed.
  "storage_migration",
  // Reads mail files (staged uploads, the server-side import folder) into an
  // imported mailbox (docs/IMPORT.md). Added with `ALTER TYPE ... ADD VALUE`:
  // see the note above about using new values in the same migration.
  "import",
  // Builds an EML ZIP or MBOX from backed-up, imported or archived mail.
  "export",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "active",
  "completed",
  "failed",
  "cancelled",
]);

/** Restore write behaviour on target collisions. */
export const restoreModeEnum = pgEnum("restore_mode", ["rename", "replace", "skip"]);

/** Restore destination: back to origin, into another account, or a download. */
export const restoreTargetTypeEnum = pgEnum("restore_target_type", [
  "original",
  "other",
  "download",
]);

/** Recovery readiness rating produced by verify / health-check reports. */
export const recoveryReadinessEnum = pgEnum("recovery_readiness", ["green", "yellow", "red"]);

/** `verify` = cheap sampled test restore; `health_check` = deep reconciliation + scrub. */
export const verifyKindEnum = pgEnum("verify_kind", ["verify", "health_check"]);

/** Resumable job cursor: folder, delta token, last item id. */
export type JobCursor = {
  folderId?: string;
  deltaToken?: string;
  lastItemId?: string;
  page?: number;
};

/**
 * A unit of work. Restow owns the lifecycle row; pg-boss owns the actual queue
 * entry (`pgBossJobId` links them). The cursor lets a restarted job resume
 * without re-fetching what it already stored. `payload` carries the queue-
 * specific input (e.g. the restore request id, a full-vs-delta flag) and
 * `errorMessage` the final failure reason shown in the UI.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    queue: jobQueueEnum("queue").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    protectedObjectId: uuid("protected_object_id").references(() => protectedObjects.id, {
      onDelete: "cascade",
    }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    cursor: jsonb("cursor").$type<JobCursor>(),
    pgBossJobId: text("pg_boss_job_id"),
    errorMessage: text("error_message"),
    // The classified cause behind `errorMessage` (why it failed and what to do); null for
    // rows written before failure records existed, which keep only the text.
    failure: jsonb("failure").$type<FailureRecordJson>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("jobs_tenant_status_idx").on(t.tenantId, t.status),
    index("jobs_object_created_idx").on(t.protectedObjectId, t.createdAt),
    // History lists a tenant's runs newest first (apps/api features/history).
    index("jobs_tenant_created_idx").on(t.tenantId, t.createdAt, t.id),
    // The runs a backup job queued itself ("Run now", the scheduler): History filters by job.
    index("jobs_backup_job_idx").on(sql`(${t.payload}->>'backupJobId')`),
  ],
);

/** Live progress for a job, streamed to the UI over SSE. One row per job. */
export const jobProgress = pgTable(
  "job_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    // What the engine stored as new data so far (after deduplication, before sealing).
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    // What the engine read and handled so far (the "processed" curve of the run drawer); never
    // below `bytes`. Rows written before 0.2.0 carry 0 and read as `bytes`.
    bytesProcessed: bigint("bytes_processed", { mode: "number" }).notNull().default(0),
    // What was written to the repository (compressed and sealed packs).
    bytesTransferred: bigint("bytes_transferred", { mode: "number" }).notNull().default(0),
    etaSeconds: integer("eta_seconds"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("job_progress_job_uq").on(t.jobId)],
);

/**
 * Items a job could not process. Stay visible with a reason, retried on the
 * next run; after 3 runs they raise an alert (see docs/ARCHITECTURE.md).
 */
export const itemFailures = pgTable(
  "item_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id").references(() => protectedObjects.id, {
      onDelete: "cascade",
    }),
    // Item id or path within the source.
    itemRef: text("item_ref").notNull(),
    reason: text("reason").notNull(),
    // The classified cause behind `reason`; null when the engine only had text.
    failure: jsonb("failure").$type<FailureRecordJson>(),
    attempts: integer("attempts").notNull().default(1),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    ...timestamps(),
  },
  // The job page lists and groups a job's failures.
  (t) => [index("item_failures_job_idx").on(t.jobId)],
);

/**
 * Restore request: source selection (snapshot + items), target, write mode, and
 * the actor. Admin restores for another user set `impersonated` and require a
 * `reason` (audited, see audit_log).
 */
export const restoreJobs = pgTable("restore_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  snapshotId: uuid("snapshot_id").references(() => snapshots.id, { onDelete: "set null" }),
  // Which folders/items/versions to restore (file-explorer selection).
  sourceSelection: jsonb("source_selection").$type<Record<string, unknown>>(),
  targetType: restoreTargetTypeEnum("target_type").notNull(),
  // Target mailbox / drive / path, or null for a download restore.
  targetRef: text("target_ref"),
  mode: restoreModeEnum("mode").notNull().default("rename"),
  // better-auth identity of the person who requested the restore.
  actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
  impersonated: boolean("impersonated").notNull().default(false),
  // Required justification for impersonated (admin-for-user) restores.
  reason: text("reason"),
  ...timestamps(),
});

/**
 * Verification / health-check outcome per protected object. `recoveryReadiness`
 * is the green/yellow/red rating with the check date; `details` holds sampled
 * items, hash mismatches and drift. `snapshotId` is the snapshot the check read
 * back, so a backup taken after a green check is not mistaken for a verified
 * one; null when the object had no snapshot yet (or it was pruned since).
 */
export const verifyReports = pgTable(
  "verify_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    snapshotId: uuid("snapshot_id").references(() => snapshots.id, { onDelete: "set null" }),
    kind: verifyKindEnum("kind").notNull().default("verify"),
    recoveryReadiness: recoveryReadinessEnum("recovery_readiness").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [index("verify_reports_object_snapshot_idx").on(t.protectedObjectId, t.snapshotId)],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobProgress = typeof jobProgress.$inferSelect;
export type NewJobProgress = typeof jobProgress.$inferInsert;
export type ItemFailure = typeof itemFailures.$inferSelect;
export type NewItemFailure = typeof itemFailures.$inferInsert;
export type RestoreJob = typeof restoreJobs.$inferSelect;
export type NewRestoreJob = typeof restoreJobs.$inferInsert;
export type VerifyReport = typeof verifyReports.$inferSelect;
export type NewVerifyReport = typeof verifyReports.$inferInsert;
