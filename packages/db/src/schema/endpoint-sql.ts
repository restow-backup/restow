import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { type EndpointSqlBackupFile, endpointRuns, endpoints } from "./endpoints.js";
import { tenants } from "./tenants.js";

/**
 * The native SQL Server backup of a Windows machine (W2a, docs/BAREMETAL-WINDOWS.md 5.1 and
 * 6.4). Both tables are tenant-scoped (RLS, sql/rls.sql). The columns of the log chain (LSNs,
 * forks, `kind` `log`/`tail`, `mode` `own_log_chain`) are here from the start, so the second stage
 * (W2b) needs no migration on filled tables; W2a writes copy-only fulls only.
 */

/** What the inventory says about one database, beside the rows of its backups. */
export type EndpointSqlDatabaseFacts = {
  databaseId?: number;
  system?: boolean;
  state?: string;
  readOnly?: boolean;
  encrypted?: boolean;
  sizeBytes?: number;
  usedBytes?: number;
  canBackup?: boolean;
  lastFullBackupAt?: string;
  lastLogBackupAt?: string;
  availabilityGroup?: string;
  secondaryReplica?: boolean;
};

/**
 * One database of one instance. A database that was dropped and created again under the same name
 * is another row (another `family_guid`); a copy under a new name is another row too (another
 * name, the same `family_guid`).
 */
export const endpointSqlDatabases = pgTable(
  "endpoint_sql_databases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    instance: text("instance").notNull(),
    database: text("database").notNull(),
    // Stays the same over restores, new with CREATE DATABASE.
    familyGuid: uuid("family_guid").notNull(),
    // The current value of sys.database_recovery_status (new after every restore).
    databaseGuid: uuid("database_guid").notNull(),
    recoveryModel: text("recovery_model").notNull(),
    mode: text("mode")
      .$type<"alongside" | "own_log_chain" | "off">()
      .notNull()
      .default("alongside"),
    // Image restore or rollback of the machine, a foreign log backup (W2b).
    chainClosedAt: timestamp("chain_closed_at", { withTimezone: true }),
    // Missing from a complete inventory of its instance; cleared when it comes back.
    droppedAt: timestamp("dropped_at", { withTimezone: true }),
    facts: jsonb("facts").$type<EndpointSqlDatabaseFacts>().notNull().default({}),
    // The last inventory or backup that named it.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // An admin confirmed that the TDE certificate and its key are backed up elsewhere.
    tdeConfirmedAt: timestamp("tde_confirmed_at", { withTimezone: true }),
    tdeConfirmedBy: text("tde_confirmed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("endpoint_sql_databases_uq").on(t.endpointId, t.instance, t.database, t.familyGuid),
    check(
      "endpoint_sql_databases_mode_ck",
      sql`${t.mode} IN ('alongside', 'own_log_chain', 'off')`,
    ),
  ],
);

/**
 * One backup file of a database in the machine's restic repository: a copy-only full (W2a), later
 * a log or tail-log backup (W2b). The chain facts come from `RESTORE HEADERONLY` of the agent's own
 * file, never from msdb (each replica of an availability group has its own msdb, and history may
 * be cleaned). `status` turns `pruned` once retention forgot the snapshot.
 */
export const endpointSqlBackups = pgTable(
  "endpoint_sql_backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    databaseId: uuid("database_id")
      .notNull()
      .references(() => endpointSqlDatabases.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => endpointRuns.id, { onDelete: "set null" }),
    kind: text("kind").$type<"full" | "log" | "tail">().notNull(),
    copyOnly: boolean("copy_only").notNull(),
    resticSnapshotId: text("restic_snapshot_id").notNull(),
    pathInSnapshot: text("path_in_snapshot").notNull(),
    // SHA-256 (hex) of the .bak file, checked by the agent after every fetch from the repository.
    sha256: text("sha256").notNull(),
    // numeric(25,0) is larger than 2^53: drizzle reads it as a string, and so does the API.
    firstLsn: numeric("first_lsn", { precision: 25, scale: 0 }).notNull(),
    lastLsn: numeric("last_lsn", { precision: 25, scale: 0 }).notNull(),
    databaseBackupLsn: numeric("database_backup_lsn", { precision: 25, scale: 0 }),
    checkpointLsn: numeric("checkpoint_lsn", { precision: 25, scale: 0 }),
    forkPointLsn: numeric("fork_point_lsn", { precision: 25, scale: 0 }),
    databaseGuid: uuid("database_guid").notNull(),
    familyGuid: uuid("family_guid").notNull(),
    firstRecoveryForkGuid: uuid("first_recovery_fork_guid"),
    lastRecoveryForkGuid: uuid("last_recovery_fork_guid"),
    beginsLogChain: boolean("begins_log_chain").notNull().default(false),
    hasBulkLoggedData: boolean("has_bulk_logged_data").notNull().default(false),
    backupStart: timestamp("backup_start", { withTimezone: true }).notNull(),
    backupFinish: timestamp("backup_finish", { withTimezone: true }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    // RESTORE FILELISTONLY of the file: the MOVE targets of the restore script for another machine.
    fileList: jsonb("file_list").$type<EndpointSqlBackupFile[]>().notNull().default([]),
    compressed: boolean("compressed").notNull().default(false),
    checksum: boolean("checksum").notNull().default(true),
    status: text("status").$type<"active" | "pruned">().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("endpoint_sql_backups_chain_idx").on(t.databaseId, t.firstLsn),
    index("endpoint_sql_backups_snapshot_idx").on(t.endpointId, t.resticSnapshotId),
    check("endpoint_sql_backups_kind_ck", sql`${t.kind} IN ('full', 'log', 'tail')`),
    check("endpoint_sql_backups_status_ck", sql`${t.status} IN ('active', 'pruned')`),
  ],
);

export type EndpointSqlDatabase = typeof endpointSqlDatabases.$inferSelect;
export type NewEndpointSqlDatabase = typeof endpointSqlDatabases.$inferInsert;
export type EndpointSqlBackup = typeof endpointSqlBackups.$inferSelect;
export type NewEndpointSqlBackup = typeof endpointSqlBackups.$inferInsert;
