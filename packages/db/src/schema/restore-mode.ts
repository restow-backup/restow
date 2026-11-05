import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * Restore mode (0.5.0, docs/STORAGE.md "Restore mode and progress markers").
 *
 * After a database dump is restored, the database knows less than the storage: backups written
 * after the dump have packs and manifests but no rows. While restore mode is on, every pass that
 * deletes storage data is refused (orphan sweep, garbage collection, retention, clean-ups, purge,
 * restic forget and prune), jobs from before the restore are held instead of resumed, and new
 * backups still run. It is switched on by the command line before the worker starts, or by the
 * worker itself when a storage target shows progress the database does not have, and switched
 * off only by a provider owner's audited confirmation.
 *
 * `installation_restore_mode` is installation-level (the installation role alone); the tables that
 * name a tenant are under Row Level Security like every tenant table (sql/rls.sql), and the
 * worker, the api and the command line read and write them on the installation pool.
 */

export const RESTORE_MODE_SOURCES = ["cli", "api", "detected"] as const;
export type RestoreModeSource = (typeof RESTORE_MODE_SOURCES)[number];

/** What happens, after restore mode ends, to data in storage the database has no row for. */
export const RESTORE_MODE_STORAGE_ONLY_DATA = ["keep", "release"] as const;
export type RestoreModeStorageOnlyData = (typeof RESTORE_MODE_STORAGE_ONLY_DATA)[number];

/** Who switched restore mode on or off. */
export interface RestoreModeActor {
  readonly label: string;
  readonly userId?: string | null;
  readonly email?: string | null;
  readonly host?: string | null;
  readonly ip?: string | null;
}

/** What the automatic detection saw when it switched restore mode on. */
export interface RestoreModeDetection {
  readonly tenantId: string;
  readonly targetId: string;
  /** The newest progress marker of this installation on the target. */
  readonly markerSeq: number | null;
  /** The database's progress value read right after the listing. */
  readonly dbSeq: number;
  /** Key versions in storage above the database's newest one. */
  readonly keyVersions: readonly number[];
  readonly installationId: string | null;
}

/** What ending restore mode did to the progress values. */
export interface RestoreModeRebase {
  readonly tenants: readonly { tenantId: string; from: number; to: number }[];
  /** Targets that could not be read at the confirmation and were accepted as such. */
  readonly acceptedUnreachable: readonly string[];
}

/**
 * Restore mode, with its history: rows are never deleted, the active one has no `ended_at`
 * (a partial unique index allows one at a time).
 */
export const installationRestoreMode = pgTable(
  "installation_restore_mode",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singleton: boolean("singleton").notNull().default(true),
    source: text("source").$type<RestoreModeSource>().notNull(),
    reason: text("reason"),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    activatedBy: jsonb("activated_by").$type<RestoreModeActor>().notNull(),
    /**
     * Jobs created before this are held, never resumed: `activated_at` when switched on by hand;
     * for a detection the start of the restored database's processes (restore-mode.ts
     * `detectedHoldBoundary`), so new backups queued before the detection still run.
     */
    holdJobsBefore: timestamp("hold_jobs_before", { withTimezone: true }).notNull(),
    detection: jsonb("detection").$type<RestoreModeDetection>(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: jsonb("ended_by").$type<RestoreModeActor>(),
    /** What the provider owner checked before ending restore mode, in their words. */
    checked: text("checked"),
    storageOnlyData: text("storage_only_data").$type<RestoreModeStorageOnlyData>(),
    /**
     * With `keep`: data unknown to the database and older than this stays for good (orphan
     * sweep, restic snapshots without a row, stray staging and export areas).
     */
    keepUnknownBefore: timestamp("keep_unknown_before", { withTimezone: true }),
    rebase: jsonb("rebase").$type<RestoreModeRebase>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("installation_restore_mode_active_uq")
      .on(t.singleton)
      .where(sql`${t.endedAt} IS NULL`),
    check("installation_restore_mode_source", sql`${t.source} IN ('cli', 'api', 'detected')`),
    check(
      "installation_restore_mode_storage_only_data",
      sql`${t.storageOnlyData} IS NULL OR ${t.storageOnlyData} IN ('keep', 'release')`,
    ),
  ],
);

export type RestoreModeRow = typeof installationRestoreMode.$inferSelect;

/**
 * The database's progress per tenant: the newest value handed to a storage progress marker
 * (`tenants/<tid>/progress/...`). Allocated in its own committed statement before the marker
 * is written, so on a healthy installation no marker in storage is above it. A missing row
 * counts as 0.
 */
export const storageProgress = pgTable(
  "storage_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull().default(0),
    rebasedAt: timestamp("rebased_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("storage_progress_tenant_uq").on(t.tenantId)],
);

/** Refused deletion passes while restore mode is on, counted per pass, tenant and day. */
export const restoreModeRefusals = pgTable(
  "restore_mode_refusals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restoreModeId: uuid("restore_mode_id")
      .notNull()
      .references(() => installationRestoreMode.id),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    pass: text("pass").notNull(),
    day: date("day").notNull(),
    count: integer("count").notNull().default(1),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
    sample: jsonb("sample").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("restore_mode_refusals_uq")
      .on(t.restoreModeId, t.pass, t.day, t.tenantId)
      .nullsNotDistinct(),
  ],
);

export const STORAGE_PROGRESS_OUTCOMES = ["ok", "ahead", "unreachable", "foreign", "none"] as const;
export type StorageProgressOutcome = (typeof STORAGE_PROGRESS_OUTCOMES)[number];

/** The last comparison of the database's progress with each storage target. */
export const storageProgressChecks = pgTable(
  "storage_progress_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    targetId: text("target_id").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: text("outcome").$type<StorageProgressOutcome>().notNull(),
    storageMaxSeq: bigint("storage_max_seq", { mode: "number" }),
    dbSeq: bigint("db_seq", { mode: "number" }).notNull(),
    unknownKeyVersions: integer("unknown_key_versions").array().notNull().default([]),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("storage_progress_checks_target_uq").on(t.tenantId, t.targetId),
    check(
      "storage_progress_checks_outcome",
      sql`${t.outcome} IN ('ok', 'ahead', 'unreachable', 'foreign', 'none')`,
    ),
  ],
);

export const KEY_MIRROR_FINDING_KINDS = ["conflict", "damaged"] as const;
export type KeyMirrorFindingKind = (typeof KEY_MIRROR_FINDING_KINDS)[number];

/**
 * A wrapped tenant key in storage (`tenants/<tid>/keys/<v>`) that differs from the database's, or
 * a sealed repository password document (`.../restow-repository-password.json`, key version 0)
 * that holds another password or does not open: never overwritten, reported once per stored
 * content.
 */
export const keyMirrorFindings = pgTable(
  "key_mirror_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    targetId: text("target_id").notNull(),
    /** 0 for a sealed repository password document, named by `object_key`. */
    keyVersion: integer("key_version").notNull(),
    /** The storage key of a sealed repository password document; null for a wrapped key. */
    objectKey: text("object_key"),
    storedSha256: text("stored_sha256").notNull(),
    kind: text("kind").$type<KeyMirrorFindingKind>().notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("key_mirror_findings_uq").on(t.tenantId, t.targetId, t.keyVersion, t.storedSha256),
    index("key_mirror_findings_open_idx").on(t.tenantId).where(sql`${t.resolvedAt} IS NULL`),
    check("key_mirror_findings_kind", sql`${t.kind} IN ('conflict', 'damaged')`),
  ],
);
