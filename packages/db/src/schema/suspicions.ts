import { sql } from "drizzle-orm";
import {
  check,
  index,
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
 * What a restore point is of (mirrors `SuspicionObjectKind` in @restow/core ransomware):
 * a machine (`endpoints.id`), a file share (`file_shares.id`), a Proxmox VE guest
 * (`pve_guests.id`) or a mailbox, OneDrive or IMAP account (`protected_objects.id`).
 */
export type SuspicionObjectKind = "endpoint" | "file_share" | "pve_guest" | "m365";

/** One reason a restore point is suspicious (mirrors `SuspicionFinding` in @restow/core). */
export type SuspicionFindingJson = {
  code: string;
  value: number;
  threshold: number;
  baseline?: number;
  bytes?: number;
  share?: number;
  examples?: string[];
};

/** The numbers a judgement was made from, kept for the baseline of later ones. */
export type SuspicionMetricsJson = {
  itemsChanged: number | null;
  itemsTotal: number | null;
  bytesAdded: number | null;
  /** The raw new data the ratios were measured on (judgements from 0.4.x on). */
  newBytes?: number | null;
  /** Stored / raw of the new data; near 1.0: it does not compress. */
  compressionRatio?: number | null;
  /** New / processed; near 1.0: nothing deduplicated. */
  dedupRatio?: number | null;
};

/**
 * The ransomware judgement of one restore point (docs/RANSOMWARE.md): whether what the backup
 * saw looks like an attack (`verdict` `suspicious`, with `findings`), which signals could be
 * judged (`signals`), and the numbers it was judged from (`metrics`, the baseline of later
 * ones). Written once per backup run by the worker (apps/worker/src/suspicion); the restore point
 * is named by the id the restore flows use (`restore_point_id`: the restic snapshot id of a
 * machine, `file_share_snapshots.id`, `pve_snapshots.id`, `snapshots.id`).
 *
 * `alerted_at` marks the first suspicious restore point of an episode, the one that raised
 * `backup.suspicious`; later ones of the same episode stay quiet. An administrator who calls a
 * finding a false alarm sets `false_alarm_*` (audited): the restore point then counts as clean,
 * feeds the object's baseline, and ends the episode.
 *
 * While an object has a suspicious restore point that is neither a false alarm nor released
 * (`hold_released_at`), retention keeps every restore point of that object (docs/RANSOMWARE.md,
 * "Retention hold"). An administrator ends the hold by calling the findings a false alarm or by
 * releasing it (`hold_released_*`, audited); a later clean restore point does not end it.
 * `hold_reminded_at` marks when an unresolved hold was last announced again
 * (`backup.suspicious_hold`).
 *
 * Tenant-scoped (RLS, sql/rls.sql); object and run ids carry no foreign key because they point
 * into four tables, so the rows of a deleted object are removed with its tenant or left as
 * history.
 */
export const restorePointSuspicions = pgTable(
  "restore_point_suspicions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectKind: text("object_kind").$type<SuspicionObjectKind>().notNull(),
    objectId: uuid("object_id").notNull(),
    // The backup run that made the restore point (endpoint_runs, file_share_runs, pve_runs, jobs).
    runId: uuid("run_id").notNull(),
    restorePointId: text("restore_point_id").notNull(),
    restorePointAt: timestamp("restore_point_at", { withTimezone: true }).notNull(),
    verdict: text("verdict").$type<"none" | "suspicious">().notNull(),
    findings: jsonb("findings").$type<SuspicionFindingJson[]>().notNull().default([]),
    signals: jsonb("signals").$type<Record<string, string>>().notNull().default({}),
    metrics: jsonb("metrics").$type<SuspicionMetricsJson>().notNull(),
    signaturesVersion: text("signatures_version").notNull(),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    falseAlarmAt: timestamp("false_alarm_at", { withTimezone: true }),
    falseAlarmByUserId: text("false_alarm_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // The label stays when the account is deleted.
    falseAlarmBy: text("false_alarm_by"),
    falseAlarmNote: text("false_alarm_note"),
    holdReleasedAt: timestamp("hold_released_at", { withTimezone: true }),
    holdReleasedByUserId: text("hold_released_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    holdReleasedBy: text("hold_released_by"),
    holdReleaseNote: text("hold_release_note"),
    holdRemindedAt: timestamp("hold_reminded_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("restore_point_suspicions_run_uq").on(t.objectKind, t.runId),
    index("restore_point_suspicions_object_idx").on(
      t.tenantId,
      t.objectKind,
      t.objectId,
      t.restorePointAt,
    ),
    index("restore_point_suspicions_tenant_verdict_idx").on(t.tenantId, t.verdict),
    check(
      "restore_point_suspicions_kind_ck",
      sql`${t.objectKind} IN ('endpoint', 'file_share', 'pve_guest', 'm365')`,
    ),
    check("restore_point_suspicions_verdict_ck", sql`${t.verdict} IN ('none', 'suspicious')`),
    check(
      "restore_point_suspicions_note_ck",
      sql`${t.falseAlarmNote} IS NULL OR char_length(${t.falseAlarmNote}) <= 1000`,
    ),
    check(
      "restore_point_suspicions_hold_note_ck",
      sql`${t.holdReleaseNote} IS NULL OR char_length(${t.holdReleaseNote}) <= 1000`,
    ),
  ],
);

export type RestorePointSuspicion = typeof restorePointSuspicions.$inferSelect;
export type NewRestorePointSuspicion = typeof restorePointSuspicions.$inferInsert;
