import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
 * Backend family. `local` covers every mounted filesystem (Docker volume, NFS);
 * `s3` covers all S3-compatible services (Garage, Hetzner, Wasabi, B2,
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
  // Absolute path inside the container (a volume or NFS mount).
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

/** One period of a target's immutability history (packages/core storage/immutability.ts). */
export type StorageTargetImmutabilityPeriod = {
  /** ISO 8601: from then on, new objects got `days` (0 = off). */
  since: string;
  days: number;
  mode: "compliance" | "governance" | "delayed_deletion" | null;
};

/**
 * A target's immutable-backup setting (docs/STORAGE.md, "Immutable backups"):
 * `compliance`/`governance` = S3 Object Lock, `delayed_deletion` = the
 * deletion delay of a directory; the history keeps every earlier setting so a
 * lowered one never applies to what was written before.
 */
export type StorageTargetImmutability = {
  mode: "compliance" | "governance" | "delayed_deletion" | null;
  days: number;
  history: readonly StorageTargetImmutabilityPeriod[];
};

/**
 * What the worker last found out about a target's immutability: the last
 * complete renewal, the last verification sample, refused deletions.
 */
export type StorageTargetImmutabilityState = {
  /** Start of the last complete renewal pass (ISO 8601). */
  renewedAt?: string | null;
  /**
   * An unfinished renewal pass (interrupted, or with failed keys): the next one continues after
   * `after` (keys in sorted order) with the same `until`, and completes as started at `startedAt`.
   */
  renewalProgress?: { startedAt: string; until: string; after: string } | null;
  renewal?: {
    at: string;
    extended: number;
    alreadyLonger: number;
    missing: number;
    failed: number;
    complete: boolean;
  } | null;
  verification?: {
    checkedAt: string;
    sampled: number;
    locked: number;
    unlocked: number;
    weakerMode: number;
    missing: number;
    errors: number;
    problems: { key: string; state: string; until: string | null; detail?: string }[];
  } | null;
};

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
    // Immutable backups (docs/STORAGE.md); null = never set.
    immutability: jsonb("immutability").$type<StorageTargetImmutability>(),
    immutabilityState: jsonb("immutability_state").$type<StorageTargetImmutabilityState>(),
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

/**
 * A deletion a target refused because the object is still locked (S3 Object
 * Lock, or a directory's deletion delay): a restic prune that met a locked
 * pack, a garbage-collected pack file, a restore point retention left alone.
 * The renewal leaves these keys out so the lock can run out; a row goes when
 * the object is gone. Shown as "deletions deferred by lock".
 */
export const immutabilityDeferredDeletions = pgTable(
  "immutability_deferred_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => storageTargets.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(1),
    // created_at: the first refusal; updated_at: the latest one.
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("immutability_deferred_target_key_uq").on(t.targetId, t.key),
    index("immutability_deferred_tenant_idx").on(t.tenantId),
  ],
);

/**
 * What a repository scan (docs/STORAGE.md, "Repository repair") found for one restic
 * repository of the tenant, compared across every storage target:
 *
 *   - `ok`: complete on the primary;
 *   - `elsewhere`: complete on another target, nothing on the primary;
 *   - `split`: `config` and keys on one target, data the holder lacks on another;
 *   - `data_only`: data, but no `config` or no key on any target;
 *   - `password_only`: only the sealed password file;
 *   - `missing`: nothing on any target;
 *   - `conflict`: two different `config` files (two chains under one prefix).
 */
export type StorageRepositoryClass =
  | "ok"
  | "elsewhere"
  | "split"
  | "data_only"
  | "password_only"
  | "missing"
  | "conflict";

/** What one target holds of a repository. */
export interface StorageRepositoryHolding {
  /** A target id, or `installation_default`. */
  readonly target: string;
  readonly targetName: string;
  readonly role: string;
  readonly config: boolean;
  readonly keys: number;
  /** Content-addressed files (data, index, snapshots), keys excluded. */
  readonly files: number;
  readonly snapshots: number;
  readonly password: boolean;
}

export interface StorageRepositoryScanEntry {
  readonly prefix: string;
  readonly kind: "container" | "machine" | "file_share";
  readonly ownerId: string;
  readonly name: string | null;
  readonly class: StorageRepositoryClass;
  readonly holdings: readonly StorageRepositoryHolding[];
  /** Files no single target holds all of: what a merge onto the primary would copy. */
  readonly filesToCopy: number;
  /** Restore points (containers) or snapshots that still refer to the repository. */
  readonly activePoints: number;
  /** Whether "apply" can rebuild it on the primary from what the targets hold. */
  readonly repairable: boolean;
}

/** The outcome of "apply" for one repository. */
export interface StorageRepositoryRepairEntry {
  readonly prefix: string;
  readonly kind: StorageRepositoryScanEntry["kind"];
  readonly ownerId: string;
  readonly name: string | null;
  readonly outcome: "merged" | "lost" | "moved_aside" | "unchanged" | "failed";
  readonly copied: number;
  readonly lostPoints: number;
  readonly movedTo: string | null;
  readonly detail: string | null;
}

export interface StorageRepositoryRepairResult {
  readonly repositories: readonly (StorageRepositoryScanEntry | StorageRepositoryRepairEntry)[];
  /** The places a scan listed (ids), the primary first. Absent on results before 0.5.0's fix. */
  readonly sources?: readonly string[];
  /**
   * The places a scan could not read (an error, or the empty or missing folder of a share that
   * is not mounted). A repair refuses to apply a scan with any: it was decided on half the facts.
   */
  readonly unreachable?: readonly { id: string; name: string; reason: string }[];
}

/**
 * A repository scan or repair of a tenant (docs/STORAGE.md, "Repository repair"): queued by an
 * administrator, run by the worker. `scan` only lists and classifies every restic repository
 * of the tenant on every target; `apply` (needs a completed scan, `scanId`) rebuilds what can be
 * rebuilt on the primary and marks what is lost.
 */
export const storageRepositoryRepairs = pgTable(
  "storage_repository_repairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"scan" | "apply">().notNull(),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed">()
      .notNull()
      .default("queued"),
    scanId: uuid("scan_id"),
    requestedBy: text("requested_by").notNull(),
    requestedByUserId: uuid("requested_by_user_id"),
    result: jsonb("result").$type<StorageRepositoryRepairResult>(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("storage_repository_repairs_tenant_idx").on(t.tenantId, t.createdAt),
    index("storage_repository_repairs_queued_idx")
      .on(t.createdAt)
      .where(sql`${t.status} IN ('queued', 'running')`),
    // One scan or repair at a time per tenant.
    uniqueIndex("storage_repository_repairs_unfinished_uq")
      .on(t.tenantId)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

export type StorageRepositoryRepair = typeof storageRepositoryRepairs.$inferSelect;

/** The state of one repository copy (docs/STORAGE.md, "restic repositories on copies"). */
export type RepositoryCopyState =
  /** Not copied yet (a new repository, a copy target added later). */
  | "pending"
  /** Every restore point the server keeps is on the copy, and its check passed. */
  | "current"
  /** Restore points are missing on the copy (`missing_snapshots`); the next pass copies them. */
  | "behind"
  /** The last attempt failed (`last_error`); the next pass tries again. */
  | "failed";

/**
 * One restic repository of the tenant (a container's `pve-guests/<id>/`, a machine's
 * `endpoints/<id>/`, a file share's `file-shares/<id>/`) on one copy target: a repository at the
 * same prefix with the same password, filled with `restic copy` (apps/worker
 * repository-copies). One row per repository and copy target; the worker's pass keeps it.
 */
export const repositoryCopies = pgTable(
  "repository_copies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The repository's storage prefix on the primary and on the copy (trailing slash). */
    prefix: text("prefix").notNull(),
    kind: text("kind").$type<"container" | "machine" | "file_share">().notNull(),
    /** The guest, machine or file share. */
    ownerId: uuid("owner_id").notNull(),
    /** The copy target: a `storage_targets` id, or `installation_default:copy:<n>`. */
    targetId: text("target_id").notNull(),
    state: text("state").$type<RepositoryCopyState>().notNull().default("pending"),
    /** Restore points the server keeps that are on the primary (the last pass). */
    primarySnapshots: integer("primary_snapshots").notNull().default(0),
    /** Of these, how many the copy does not hold yet (the lag). */
    missingSnapshots: integer("missing_snapshots").notNull().default(0),
    /** The newest restore point on the copy (its id on the primary, restic's `original`). */
    lastSnapshotId: text("last_snapshot_id"),
    /** When the last pass that got through copied (or found nothing to copy). */
    lastCopiedAt: timestamp("last_copied_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** Snapshots forgotten on the copy by the last pass (retention on the copy). */
    lastForgotten: integer("last_forgotten").notNull().default(0),
    /** Retention on the copy was due but deleting is not possible there (write-once, restore mode). */
    deletionsDeferred: text("deletions_deferred"),
    /** `restic check` (structure) after the last copy: passed, or what it found. */
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastCheckOk: boolean("last_check_ok"),
    lastCheckMessage: text("last_check_message"),
    /** The last `check --read-data-subset` of a sample (weekly). */
    lastDataCheckAt: timestamp("last_data_check_at", { withTimezone: true }),
    /** Since when the copy is behind or failing (null while current): the alert after 2 days. */
    troubleSince: timestamp("trouble_since", { withTimezone: true }),
    /** When the alert of the current episode was raised (once per episode). */
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("repository_copies_uq").on(t.tenantId, t.prefix, t.targetId),
    index("repository_copies_owner_idx").on(t.tenantId, t.ownerId),
  ],
);

export type RepositoryCopy = typeof repositoryCopies.$inferSelect;

export type ImmutabilityDeferredDeletion = typeof immutabilityDeferredDeletions.$inferSelect;
export type StorageTarget = typeof storageTargets.$inferSelect;
export type NewStorageTarget = typeof storageTargets.$inferInsert;
export type StorageTargetKind = (typeof storageTargetKindEnum.enumValues)[number];
export type StorageTargetRole = (typeof storageTargetRoleEnum.enumValues)[number];
export type StorageTargetStatus = (typeof storageTargetStatusEnum.enumValues)[number];
export type StorageMigration = typeof storageMigrations.$inferSelect;
export type NewStorageMigration = typeof storageMigrations.$inferInsert;
export type StorageMigrationMode = (typeof storageMigrationModeEnum.enumValues)[number];
export type StorageMigrationStatus = (typeof storageMigrationStatusEnum.enumValues)[number];
