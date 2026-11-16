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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { notificationLevelEnum } from "./notifications.js";
import { providers } from "./providers.js";
import { type DeliveryModes, tenantLanguageEnum, tenants } from "./tenants.js";
import { webhooks } from "./webhooks.js";

/** What makes a rule fire: an event the product raises, or a point in time. */
export const reportTriggerEnum = pgEnum("report_trigger", ["event", "schedule"]);

/** The digest an e-mail delivery waits for (0.5.0): sent with the others of its window. */
export const reportDigestWindowEnum = pgEnum("report_digest_window", ["hourly", "daily"]);

/**
 * The calendar cadence of a summary report (0.5.0): the previous day, the previous Monday to
 * Sunday, the previous calendar month, in the rule's time zone (packages/core reports/period.ts).
 */
export const reportCadenceEnum = pgEnum("report_cadence", ["daily", "weekly", "monthly"]);

/**
 * What a schedule rule sends: the summary report, or the customer monthly report (Service
 * Provider, ee/api reports/customer.ts) to the tenant's contacts.
 */
export const reportRuleKindEnum = pgEnum("report_rule_kind", ["summary", "customer"]);

/**
 * A provider notification recipient (0.5.0): an owner of the provider team, kept in step with the
 * team (`owner`, never removed while the person is an owner), or anyone the provider adds.
 */
export const providerRecipientKindEnum = pgEnum("provider_recipient_kind", ["owner", "member"]);

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
 * `overdueAfterHours` (event rules that list `backup.overdue` only) is the rule's own
 * "no successful backup for X hours" deadline: it replaces the bound the jobs' schedules give
 * for this rule's alerts (apps/worker overdue.ts); null follows the schedules.
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
    overdueAfterHours: integer("overdue_after_hours"),
    // Set on the rule that carries one category of the tenant's notification recipients
    // (`jobFailures`, `readinessRed`, `weeklyReport`): its e-mail recipients are the recipients
    // who chose that category, kept in step whenever the recipients are saved. Null for every
    // rule an administrator made by hand.
    recipientCategory: text("recipient_category"),
    // A schedule rule's calendar cadence (0.5.0): the period is the previous day, week or month
    // in `timezone`; null keeps the rolling `periodDays` of a custom interval or cron.
    cadence: reportCadenceEnum("cadence"),
    // Attach the PDF statistics report (summary) or the customer report's PDF (customer).
    attachPdf: boolean("attach_pdf").notNull().default(false),
    kind: reportRuleKindEnum("kind").notNull().default("summary"),
    createdBy: text("created_by"),
    ...timestamps(),
  },
  (t) => [
    index("report_rules_tenant_idx").on(t.tenantId),
    check("report_rules_cadence_ck", sql`${t.cadence} IS NULL OR ${t.trigger} = 'schedule'`),
    uniqueIndex("report_rules_recipient_category_uq")
      .on(t.tenantId, t.recipientCategory)
      .where(sql`${t.recipientCategory} IS NOT NULL`),
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
    check(
      "report_rules_overdue_after_ck",
      sql`${t.overdueAfterHours} IS NULL OR ${t.overdueAfterHours} BETWEEN 24 AND 720`,
    ),
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
    // Null for the provider's own deliveries (0.5.0): its recipients and its summary reports.
    // Row Level Security hides those rows from every tenant-pinned session.
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
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
    // A provider delivery's tenant (the alert is about it); null for installation events and
    // reports across tenants.
    aboutTenantId: uuid("about_tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    providerRecipientId: uuid("provider_recipient_id").references(
      () => providerNotificationRecipients.id,
      { onDelete: "set null" },
    ),
    providerRuleId: uuid("provider_rule_id").references(() => providerReportRules.id, {
      onDelete: "set null",
    }),
    // The event the row was planned for (`report_events.id`); no foreign key, events are pruned.
    reportEventId: uuid("report_event_id"),
    // Held for the recipient's digest; `next_attempt_at` is when the digest goes out.
    digest: reportDigestWindowEnum("digest"),
    // Shared by every row sent in one digest mail.
    digestGroup: uuid("digest_group"),
    ...timestamps(),
  },
  (t) => [
    index("report_deliveries_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("report_deliveries_status_next_idx").on(t.status, t.nextAttemptAt),
    index("report_deliveries_throttle_idx").on(t.ruleId, t.subjectKey, t.createdAt),
    index("report_deliveries_digest_due_idx")
      .on(t.status, t.digest, t.nextAttemptAt)
      .where(sql`${t.digest} IS NOT NULL`),
    index("report_deliveries_provider_throttle_idx")
      .on(t.providerRecipientId, t.subjectKey, t.createdAt)
      .where(sql`${t.providerRecipientId} IS NOT NULL`),
    index("report_deliveries_event_idx")
      .on(t.reportEventId)
      .where(sql`${t.reportEventId} IS NOT NULL`),
    check("report_deliveries_scope_ck", sql`${t.tenantId} IS NOT NULL OR ${t.ruleId} IS NULL`),
  ],
);

/**
 * Every event that reached the rules (0.5.0), for the provider's recipients: the API's dispatcher
 * claims the rows not yet fanned out and plans the provider deliveries from them
 * (apps/api features/reports/fanout.ts). `tenant_id` null is an installation event. Rows are
 * pruned a week after their fan-out.
 */
export const reportEvents = pgTable(
  "report_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    level: notificationLevelEnum("level").notNull(),
    subjectKey: text("subject_key").notNull(),
    message: text("message"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    fannedOutAt: timestamp("fanned_out_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("report_events_pending_idx").on(t.createdAt).where(sql`${t.fannedOutAt} IS NULL`)],
);

/**
 * Who the provider tells about events across every tenant (0.5.0, docs/NOTIFICATIONS.md): the
 * owners of the provider team (`kind = 'owner'`, synced from the team) and anyone added by hand.
 * The owners and the recipients marked `mandatory` are the floor: they always get the critical
 * events and failed deliveries, whatever their column says. `events` holds catalog events,
 * installation events and `report.daily|weekly|monthly`; `delivery` the digest mode per severity.
 */
export const providerNotificationRecipients = pgTable(
  "provider_notification_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    name: text("name"),
    kind: providerRecipientKindEnum("kind").notNull().default("member"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    mandatory: boolean("mandatory").notNull().default(false),
    events: text("events").array().notNull().default(sql`'{}'::text[]`),
    delivery: jsonb("delivery").$type<DeliveryModes>().notNull().default({}),
    language: tenantLanguageEnum("language"),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    failureAlertedAt: timestamp("failure_alerted_at", { withTimezone: true }),
    lastFailureReason: text("last_failure_reason"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("provider_notification_recipients_email_uq").on(sql`lower(${t.email})`),
    uniqueIndex("provider_notification_recipients_owner_uq")
      .on(t.userId)
      .where(sql`${t.kind} = 'owner'`),
  ],
);

/**
 * The provider's summary reports across tenants (0.5.0, Business and up): one row per cadence,
 * sent to the provider recipients that chose `report.<cadence>` (kept in `email_recipients`).
 */
export const providerReportRules = pgTable(
  "provider_report_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cadence: reportCadenceEnum("cadence").notNull().unique(),
    enabled: boolean("enabled").notNull().default(true),
    timezone: text("timezone").notNull(),
    sendHour: integer("send_hour").notNull().default(7),
    attachPdf: boolean("attach_pdf").notNull().default(true),
    emailRecipients: text("email_recipients").array().notNull().default(sql`'{}'::text[]`),
    language: tenantLanguageEnum("language"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [check("provider_report_rules_send_hour_ck", sql`${t.sendHour} BETWEEN 0 AND 23`)],
);

export type ReportRule = typeof reportRules.$inferSelect;
export type NewReportRule = typeof reportRules.$inferInsert;
export type ReportDelivery = typeof reportDeliveries.$inferSelect;
export type NewReportDelivery = typeof reportDeliveries.$inferInsert;
export type ReportTrigger = (typeof reportTriggerEnum.enumValues)[number];
export type ReportChannel = (typeof reportChannelEnum.enumValues)[number];
export type ReportDeliveryStatus = (typeof reportDeliveryStatusEnum.enumValues)[number];
export type ReportEventRow = typeof reportEvents.$inferSelect;
export type NewReportEventRow = typeof reportEvents.$inferInsert;
export type ProviderNotificationRecipient = typeof providerNotificationRecipients.$inferSelect;
export type NewProviderNotificationRecipient = typeof providerNotificationRecipients.$inferInsert;
export type ProviderReportRule = typeof providerReportRules.$inferSelect;
export type ReportCadenceValue = (typeof reportCadenceEnum.enumValues)[number];
export type ReportDigestWindow = (typeof reportDigestWindowEnum.enumValues)[number];
