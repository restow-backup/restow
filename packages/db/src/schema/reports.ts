import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { tenantLanguageEnum, tenants } from "./tenants.js";
import { webhooks } from "./webhooks.js";

/** What makes a rule fire: an event the product raises, or a point in time. */
export const reportTriggerEnum = pgEnum("report_trigger", ["event", "schedule"]);

/**
 * A tenant's notification and report rules (docs/ARCHITECTURE.md, Reports
 * and notifications). An `event` rule sends an alert for each matching event
 * (`events`, names from packages/core reports/catalog.ts), at most once per
 * rule and subject (a mailbox, a job queue) within `throttleMinutes`. A
 * `schedule` rule sends a summary report of the last `periodDays` built from
 * `sections`, on a cadence like a schedule's: `intervalMinutes` XOR `cron`
 * (evaluated in `timezone`). Channels: `emailRecipients`, `inApp` (the bell;
 * events always reach it, so the flag matters for reports only) and an
 * existing `webhookId`. `language` null means the tenant's language.
 */
export const reportRules = pgTable(
  "report_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    trigger: reportTriggerEnum("trigger").notNull(),
    events: text("events").array().notNull().default(sql`'{}'::text[]`),
    throttleMinutes: integer("throttle_minutes").notNull().default(60),
    intervalMinutes: integer("interval_minutes"),
    cron: text("cron"),
    timezone: text("timezone").notNull().default("UTC"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    periodDays: integer("period_days").notNull().default(7),
    sections: text("sections").array().notNull().default(sql`'{}'::text[]`),
    emailRecipients: text("email_recipients").array().notNull().default(sql`'{}'::text[]`),
    inApp: boolean("in_app").notNull().default(false),
    webhookId: uuid("webhook_id").references(() => webhooks.id, { onDelete: "set null" }),
    language: tenantLanguageEnum("language"),
    createdBy: text("created_by"),
    ...timestamps(),
  },
  (t) => [
    index("report_rules_tenant_idx").on(t.tenantId),
    index("report_rules_due_idx").on(t.trigger, t.enabled, t.nextRunAt),
    check(
      "report_rules_schedule_cadence_ck",
      sql`${t.trigger} <> 'schedule' OR ((${t.intervalMinutes} IS NOT NULL) <> (${t.cron} IS NOT NULL))`,
    ),
    check(
      "report_rules_interval_positive_ck",
      sql`${t.intervalMinutes} IS NULL OR ${t.intervalMinutes} > 0`,
    ),
    check("report_rules_period_ck", sql`${t.periodDays} BETWEEN 1 AND 366`),
    check("report_rules_throttle_ck", sql`${t.throttleMinutes} BETWEEN 0 AND 10080`),
  ],
);

export const reportDeliveryKindEnum = pgEnum("report_delivery_kind", ["event", "summary"]);
export const reportChannelEnum = pgEnum("report_channel", ["email", "in_app", "webhook"]);
export const reportDeliveryStatusEnum = pgEnum("report_delivery_status", [
  "pending",
  "sent",
  "failed",
  "skipped",
]);

/**
 * The outbox and the delivery log in one (like `webhook_deliveries`): the
 * worker and the scheduler insert `pending` rows, the API's dispatcher claims
 * due rows (`leaseUntil`), renders them in `language` and sends them, and
 * records the outcome. One row per channel and recipient. `ruleName` is kept
 * so the log still reads after a rule is deleted. `subjectKey` groups an
 * event rule's alerts for throttling (e.g. the protected object's id).
 */
export const reportDeliveries = pgTable(
  "report_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => reportRules.id, { onDelete: "set null" }),
    ruleName: text("rule_name").notNull(),
    kind: reportDeliveryKindEnum("kind").notNull(),
    event: text("event"),
    subjectKey: text("subject_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    channel: reportChannelEnum("channel").notNull(),
    recipient: text("recipient"),
    language: tenantLanguageEnum("language"),
    status: reportDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("report_deliveries_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("report_deliveries_status_next_idx").on(t.status, t.nextAttemptAt),
    index("report_deliveries_throttle_idx").on(t.ruleId, t.subjectKey, t.createdAt),
  ],
);

export type ReportRule = typeof reportRules.$inferSelect;
export type NewReportRule = typeof reportRules.$inferInsert;
export type ReportDelivery = typeof reportDeliveries.$inferSelect;
export type NewReportDelivery = typeof reportDeliveries.$inferInsert;
export type ReportTrigger = (typeof reportTriggerEnum.enumValues)[number];
export type ReportChannel = (typeof reportChannelEnum.enumValues)[number];
export type ReportDeliveryStatus = (typeof reportDeliveryStatusEnum.enumValues)[number];
