import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { protectedObjects } from "./sources.js";
import { tenants } from "./tenants.js";

/**
 * What a schedule enqueues. Mirrors the job queues that run unattended:
 * backup, verify (sampled test restore), retention (archive deletion run),
 * scrub (pack integrity), directory (Entra users/delta sync) and archive
 * (IMAP/Graph archive sync).
 */
export const scheduleKindEnum = pgEnum("schedule_kind", [
  "backup",
  "verify",
  "retention",
  "scrub",
  "directory",
  "archive",
]);

/**
 * Recurring schedules evaluated by the scheduler. Since 0.2.0 backup and
 * restore-check schedules of a mail job live in `backup_jobs`; what stays here
 * is the maintenance (retention run, storage check, directory sync, archive
 * sync) and the schedules an older release made (`superseded_by_job_id` marks
 * the ones a job took over). A schedule is either a
 * fixed interval (`intervalMinutes`) or a cron expression (`cron`, five fields,
 * evaluated in `timezone`) — exactly one of the two is set. `protectedObjectId`
 * narrows a schedule to one mailbox/drive; null means every active protected
 * object of the tenant (backup/verify) or the tenant as a whole (retention,
 * scrub, directory).
 */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id").references(() => protectedObjects.id, {
      onDelete: "cascade",
    }),
    kind: scheduleKindEnum("kind").notNull(),
    intervalMinutes: integer("interval_minutes"),
    cron: text("cron"),
    // IANA zone the cron expression is evaluated in.
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    // The backup job that took this schedule over (0.2.0, docs/ARCHITECTURE.md "Jobs"): the
    // scheduler no longer plans it and the schedule API refuses to change it, but the row stays.
    // A plain reference without a foreign key on purpose: deleting the job must never revive
    // the schedule it replaced.
    supersededByJobId: uuid("superseded_by_job_id"),
    ...timestamps(),
  },
  (t) => [
    index("schedules_due_idx").on(t.enabled, t.nextRunAt),
    index("schedules_tenant_kind_idx").on(t.tenantId, t.kind),
    check(
      "schedules_interval_xor_cron_ck",
      sql`(${t.intervalMinutes} IS NOT NULL) <> (${t.cron} IS NOT NULL)`,
    ),
    check(
      "schedules_interval_positive_ck",
      sql`${t.intervalMinutes} IS NULL OR ${t.intervalMinutes} > 0`,
    ),
  ],
);

export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;
export type ScheduleKind = (typeof scheduleKindEnum.enumValues)[number];
