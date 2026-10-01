import { sql } from "drizzle-orm";
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
import { timestamps } from "./_shared.js";
import { jobs } from "./jobs.js";
import { secrets } from "./secrets.js";
import { tenants } from "./tenants.js";

/**
 * Backend family. `local` covers every mounted filesystem (Docker volume, NFS,
 * SMB); `s3` covers all S3-compatible services (Garage, Hetzner, Wasabi, B2,
 * AWS — not MinIO, which is no longer open source). `installation_default` is
 * a placeholder row with no config of its own: it stands for whatever the
 * environment configures as the default target, needed when that default
 * becomes a tenant's `previous` target during a storage migration (see
 * storageMigrations below). See docs/ARCHITECTURE.md, Chunk-Store / Backends.
 *
 * `installation_default` was added to this enum by an `ALTER TYPE ... ADD
 * VALUE` migration, so no migration in the same file may use it (in DDL,
 * defaults, partial-index predicates or a backfill) — Postgres refuses that as
 * an unsafe use of a new enum value. A later migration that needs it is safe;
 * test it against a fresh install, not only an upgrade.
 */
export const storageTargetKindEnum = pgEnum("storage_target_kind", [
  "local",
  "s3",
  "installation_default",
]);

/**
 * One `primary` target per tenant receives writes; `copy` targets are
 * replicated to. `previous` is a read-only former primary, retired by a
 * storage migration under either mode (see `storageMigrationModeEnum` below
 * for the `move`/`keep` difference): never written, but still read by
 * restore, verify and download until retention removes its last restore
 * point.
 *
 * `previous` was added to this enum by an `ALTER TYPE ... ADD VALUE`
 * migration; the same-migration restriction noted on `storage_target_kind`
 * above applies.
 */
export const storageTargetRoleEnum = pgEnum("storage_target_role", ["primary", "copy", "previous"]);

/** Last probe result: never probed, reachable and writable, or failing. */
export const storageTargetStatusEnum = pgEnum("storage_target_status", [
  "unverified",
  "ok",
  "error",
]);

export type LocalStorageTargetConfig = {
  // Absolute path inside the container (a volume or NFS/SMB mount).
  basePath: string;
};

export type S3StorageTargetConfig = {
  bucket: string;
  // Optional key prefix (installation namespace) prepended to every key.
  prefix?: string;
  // Custom endpoint for non-AWS services; omit for AWS.
  endpoint?: string;
  region?: string;
  // Path-style addressing (e.g. Garage) instead of virtual-hosted buckets.
  forcePathStyle?: boolean;
  // Whether the bucket has Object Lock enabled (archive WORM, docs/ARCHIVE.md).
  objectLock?: boolean;
};

/** An `installation_default` target holds no addressing of its own. */
export type InstallationDefaultStorageTargetConfig = Record<string, never>;

/** Non-secret connection settings; credentials live behind `secret_ref`. */
export type StorageTargetConfig =
  | LocalStorageTargetConfig
  | S3StorageTargetConfig
  | InstallationDefaultStorageTargetConfig;

/**
 * Where a tenant's chunk store lives. Each tenant has exactly one `primary`
 * target and any number of `copy` targets (docs/ARCHITECTURE.md: primary plus
 * copy). `config` holds only addressing; S3 access keys are stored encrypted
 * in `secrets`. `bytesUsed` is maintained by the pack writer and scrub.
 */
export const storageTargets = pgTable(
  "storage_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name"),
    kind: storageTargetKindEnum("kind").notNull(),
    role: storageTargetRoleEnum("role").notNull().default("primary"),
    config: jsonb("config").$type<StorageTargetConfig>().notNull(),
    secretRef: uuid("secret_ref").references(() => secrets.id, { onDelete: "set null" }),
    status: storageTargetStatusEnum("status").notNull().default("unverified"),
    // Last probe failure, shown to the operator as-is (never contains secrets).
    errorMessage: text("error_message"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    bytesUsed: bigint("bytes_used", { mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("storage_targets_tenant_primary_uq")
      .on(t.tenantId)
      .where(sql`${t.role} = 'primary'`),
    index("storage_targets_tenant_idx").on(t.tenantId),
  ],
);

/**
 * `move` copies the tenant's backups to the new target and then retires the
 * old one (its role becomes `previous`); `keep` leaves the old target attached
 * read-only (also `previous`) and sends only new backups to the new target.
 */
export const storageMigrationModeEnum = pgEnum("storage_migration_mode", ["move", "keep"]);

/**
 * Storage migration lifecycle: `queued` (not started), `copying` (packs and
 * manifests), `verifying` (hash comparison of what was copied), `switching`
 * (the atomic primary swap), `completed`, `failed` (see `error_message`) or
 * `cancelled` by an admin before it finished.
 */
export const storageMigrationStatusEnum = pgEnum("storage_migration_status", [
  "queued",
  "copying",
  "verifying",
  "switching",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * A background job that moves a tenant off one storage target onto another:
 * adding a target and choosing to replace the primary starts this instead of
 * an instant cutover, so existing backups stay reachable throughout.
 * `sourceTargetId` is null when the tenant's current primary is the
 * installation default (no `storage_targets` row of its own); `mode` decides
 * whether the source becomes a retired `previous` target (`move`) or stays
 * attached read-only from the start (`keep` skips `copying`/`verifying` and
 * switches immediately). `jobId` links the pg-boss `storage_migration` job
 * that does the work; the row itself is the durable, queryable status the UI
 * polls. Progress counters mirror `job_progress` shape but live here because a
 * migration can outlive a single job attempt (retried after a worker restart).
 *
 * `sourceTargetId` and `destinationTargetId` reference `storage_targets` with
 * `onDelete: "restrict"` on purpose, including for a `completed` migration:
 * this history is the evidence that a move happened and how it was verified,
 * and a storage target cannot be deleted while any row still names it. This
 * is deliberate, not an oversight — the API storage service that implements
 * target deletion must remove or archive a target's finished migration rows
 * in the same transaction as the delete; deleting a target that an
 * unfinished migration still references must keep failing. That
 * removal-or-archive step belongs to whoever implements target deletion, not
 * to this schema.
 *
 * `sourceTargetId`, `destinationTargetId` and `jobId` reference other tables
 * by a single column, the same pattern `storage_targets.tenantId` uses
 * elsewhere in this file: the foreign key alone does not confirm the
 * referenced row belongs to the same tenant (FK checks run outside RLS).
 * Whoever writes these columns — the storage-migration service — must
 * verify both targets (and, if set, the job) are pinned to this row's
 * `tenantId` before inserting or updating; that check belongs to the
 * service, not to this schema.
 */
export const storageMigrations = pgTable(
  "storage_migrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Null = the installation default was the tenant's primary before this migration.
    sourceTargetId: uuid("source_target_id").references(() => storageTargets.id, {
      onDelete: "restrict",
    }),
    destinationTargetId: uuid("destination_target_id")
      .notNull()
      .references(() => storageTargets.id, { onDelete: "restrict" }),
    mode: storageMigrationModeEnum("mode").notNull(),
    status: storageMigrationStatusEnum("status").notNull().default("queued"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    objectsTotal: integer("objects_total").notNull().default(0),
    objectsDone: integer("objects_done").notNull().default(0),
    bytesTotal: bigint("bytes_total", { mode: "number" }).notNull().default(0),
    bytesDone: bigint("bytes_done", { mode: "number" }).notNull().default(0),
    // Failure reason, shown to the operator as-is (never contains secrets).
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    switchedAt: timestamp("switched_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("storage_migrations_tenant_idx").on(t.tenantId),
    // At most one migration in flight per tenant; a completed/failed/cancelled
    // one does not block starting another.
    uniqueIndex("storage_migrations_tenant_unfinished_uq")
      .on(t.tenantId)
      .where(sql`${t.status} IN ('queued', 'copying', 'verifying', 'switching')`),
  ],
);

export type StorageTarget = typeof storageTargets.$inferSelect;
export type NewStorageTarget = typeof storageTargets.$inferInsert;
export type StorageTargetKind = (typeof storageTargetKindEnum.enumValues)[number];
export type StorageTargetRole = (typeof storageTargetRoleEnum.enumValues)[number];
export type StorageTargetStatus = (typeof storageTargetStatusEnum.enumValues)[number];
export type StorageMigration = typeof storageMigrations.$inferSelect;
export type NewStorageMigration = typeof storageMigrations.$inferInsert;
export type StorageMigrationMode = (typeof storageMigrationModeEnum.enumValues)[number];
export type StorageMigrationStatus = (typeof storageMigrationStatusEnum.enumValues)[number];
