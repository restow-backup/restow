import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { tenants } from "./tenants.js";

/**
 * What a run size hold is about (mirrors `RunSizeObjectKind` in @restow/core run-size): a machine
 * (`endpoints.id`), a file share (`file_shares.id`), a Proxmox VE guest (`pve_guests.id`) or a
 * mailbox, OneDrive, site or IMAP account (`protected_objects.id`).
 */
export type RunSizeHoldObjectKind = "endpoint" | "file_share" | "pve_guest" | "m365";

/**
 * `pending`   the run was held; every further run of the object is held at its first upload
 * `approved`  an administrator let the next run continue once (it consumes the approval)
 * `resolved`  over: the approval was used, the limit was raised, or the guard switched off
 */
export type RunSizeHoldStatus = "pending" | "approved" | "resolved";

export const RUN_SIZE_HOLD_RESOLUTIONS = [
  "continued",
  "limit_raised",
  "guard_off",
  "settings_changed",
  "space_freed",
  "object_removed",
] as const;
export type RunSizeHoldResolution = (typeof RUN_SIZE_HOLD_RESOLUTIONS)[number];

/**
 * A backup run the size and space guard held (#99, docs/STORAGE.md "Unusually large runs"):
 * it would have added far more than the object usually does, or left its storage target less
 * free space than the guard keeps. Written by whoever measured the run: the api for runs through
 * its restic REST endpoint (machines, file shares, Proxmox VE containers), the worker for runs
 * into the chunk store (mailboxes, OneDrive, SharePoint, IMAP). At most one open hold
 * (`pending` or `approved`) per object; it raised `backup.unusually_large` once (`alerted_at`),
 * and counts the later runs it held (`refused_runs`). Continuing once and raising the limit are
 * audited (apps/api features/run-size).
 *
 * Tenant-scoped (RLS, sql/rls.sql). Object and run ids carry no foreign key: they point into four
 * tables, like `restore_point_suspicions`.
 */
export const runSizeHolds = pgTable(
  "run_size_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectKind: text("object_kind").$type<RunSizeHoldObjectKind>().notNull(),
    objectId: uuid("object_id").notNull(),
    // The name at the time, for the list and the alert (the object may be renamed or removed).
    objectName: text("object_name").notNull(),
    // The run that was held (endpoint_runs, file_share_runs, pve_runs, jobs); null when unknown.
    runId: uuid("run_id"),
    reason: text("reason").$type<"size" | "space">().notNull(),
    status: text("status").$type<RunSizeHoldStatus>().notNull().default("pending"),
    // What the run had added with the upload that was refused.
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    // The size limit it passed (null for a hold for space).
    limitBytes: bigint("limit_bytes", { mode: "number" }),
    // The median of the object's earlier runs, and how many it was taken over.
    medianBytes: bigint("median_bytes", { mode: "number" }),
    historyRuns: integer("history_runs").notNull().default(0),
    // The target's space when it was held (a hold for space; also kept for one for size).
    freeBytes: bigint("free_bytes", { mode: "number" }),
    totalBytes: bigint("total_bytes", { mode: "number" }),
    // Later runs held by this hold while it waited.
    refusedRuns: integer("refused_runs").notNull().default(0),
    lastRefusedAt: timestamp("last_refused_at", { withTimezone: true }),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // The label stays when the account is deleted.
    approvedBy: text("approved_by"),
    note: text("note"),
    // `continued` (the approval was used), `limit_raised`, `guard_off`, `settings_changed` (the
    // object's settings no longer hold it), `space_freed` (a hold for space whose target has room
    // again), `object_removed` (its machine, share, guest or account is gone).
    resolution: text("resolution").$type<RunSizeHoldResolution>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // The run that used the approval.
    consumedRunId: uuid("consumed_run_id"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("run_size_holds_open_uq")
      .on(t.objectKind, t.objectId)
      .where(sql`${t.status} IN ('pending', 'approved')`),
    index("run_size_holds_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
    check(
      "run_size_holds_kind_ck",
      sql`${t.objectKind} IN ('endpoint', 'file_share', 'pve_guest', 'm365')`,
    ),
    check("run_size_holds_reason_ck", sql`${t.reason} IN ('size', 'space')`),
    check("run_size_holds_status_ck", sql`${t.status} IN ('pending', 'approved', 'resolved')`),
    check(
      "run_size_holds_resolution_ck",
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('continued', 'limit_raised', 'guard_off', 'settings_changed', 'space_freed', 'object_removed')`,
    ),
    check("run_size_holds_note_ck", sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`),
  ],
);

export type RunSizeHold = typeof runSizeHolds.$inferSelect;
export type NewRunSizeHold = typeof runSizeHolds.$inferInsert;

/**
 * The guard's settings of a tenant (`object_kind` and `object_id` null) or of one object (#99):
 * an override over the defaults (@restow/core `RunSizeGuardOverride`, `{}` changes nothing). The
 * object's applies over the tenant's. Changes are audited (`backup.size_guard_changed`).
 */
export const runSizeSettings = pgTable(
  "run_size_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectKind: text("object_kind").$type<RunSizeHoldObjectKind>(),
    objectId: uuid("object_id"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    updatedByUserId: text("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedBy: text("updated_by"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("run_size_settings_tenant_uq").on(t.tenantId).where(sql`${t.objectKind} IS NULL`),
    uniqueIndex("run_size_settings_object_uq")
      .on(t.tenantId, t.objectKind, t.objectId)
      .where(sql`${t.objectKind} IS NOT NULL`),
    check("run_size_settings_scope_ck", sql`(${t.objectKind} IS NULL) = (${t.objectId} IS NULL)`),
    check(
      "run_size_settings_kind_ck",
      sql`${t.objectKind} IS NULL OR ${t.objectKind} IN ('endpoint', 'file_share', 'pve_guest', 'm365')`,
    ),
  ],
);

export type RunSizeSettingsRow = typeof runSizeSettings.$inferSelect;

/**
 * What the guard knows of one run (#99), kept so that it survives the process that measures it:
 * an api restart, a second api process, a retry of a mailbox backup under the same job id. The
 * bytes the run stored so far (`written_bytes`, written at most every 256 MiB or 30 seconds, so a
 * process that dies loses at most that much), and why the run is exempt: `continued` (it used an
 * administrator's "continue once") or `new_repository` (it began a new repository: its full
 * upload is no unusual run, and the object's history starts again with it).
 */
export const runSizeRuns = pgTable(
  "run_size_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectKind: text("object_kind").$type<RunSizeHoldObjectKind>().notNull(),
    objectId: uuid("object_id").notNull(),
    runId: uuid("run_id").notNull(),
    writtenBytes: bigint("written_bytes", { mode: "number" }).notNull().default(0),
    exemption: text("exemption").$type<"continued" | "new_repository">(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("run_size_runs_run_uq").on(t.objectKind, t.runId),
    index("run_size_runs_object_idx").on(t.objectKind, t.objectId, t.createdAt),
    check(
      "run_size_runs_kind_ck",
      sql`${t.objectKind} IN ('endpoint', 'file_share', 'pve_guest', 'm365')`,
    ),
    check(
      "run_size_runs_exemption_ck",
      sql`${t.exemption} IS NULL OR ${t.exemption} IN ('continued', 'new_repository')`,
    ),
  ],
);

export type RunSizeRun = typeof runSizeRuns.$inferSelect;
