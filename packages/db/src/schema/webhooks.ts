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
import { providers } from "./providers.js";
import { secrets } from "./secrets.js";
import { tenants } from "./tenants.js";

/** Delivery lifecycle: queued for (re)try, delivered (2xx), or given up. */
export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "delivered",
  "failed",
]);

/**
 * What a webhook's requests look like: `restow` is the signed JSON envelope
 * (X-Restow-Signature) for RMM, PSA and own receivers; `discord`, `slack` and
 * `teams` are chat messages in the shape of that service's incoming webhooks
 * (Teams: Workflows / Power Automate), sent without a signature because those
 * services cannot check one.
 */
export const webhookFormatEnum = pgEnum("webhook_format", ["restow", "discord", "slack", "teams"]);

/**
 * Outbound webhook subscription per tenant. Payloads of the `restow` format are signed with HMAC-SHA-256
 * using the secret behind `secretRef` (stored encrypted, never here). `events`
 * is the webhook's column in the notification matrix: the catalog events it gets
 * (e.g. "backup.failed", "backup.succeeded"; packages/core reports/catalog.ts), from
 * alert rules and from the webhook stream alike, plus the stream events it subscribed
 * to ("job.failed", "job.completed", "verify.completed"). A stream delivery goes out
 * when both its stream event and the catalog event it is about are listed. An empty
 * list gets nothing.
 */
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name"),
    url: text("url").notNull(),
    secretRef: uuid("secret_ref").references(() => secrets.id, { onDelete: "set null" }),
    events: text("events").array().notNull().default(sql`'{}'::text[]`),
    active: boolean("active").notNull().default(true),
    format: webhookFormatEnum("format").notNull().default("restow"),
    // Health (0.5.0): the failure episode the worker records after each attempt. A webhook that
    // fails permanently, or three attempts in a row over at least 15 minutes, raises
    // `notification.delivery_failed` once (`failure_alerted_at`); the next delivery resets it.
    failingSince: timestamp("failing_since", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    failureAlertedAt: timestamp("failure_alerted_at", { withTimezone: true }),
    lastFailure: text("last_failure"),
    ...timestamps(),
  },
  (t) => [index("webhooks_tenant_idx").on(t.tenantId)],
);

/**
 * The provider's own webhooks (0.6.0, Service Provider; docs/ARCHITECTURE.md, "Webhooks des
 * Providers"): events of the installation rather than of one tenant, such as
 * `billing.period_closed` of the monthly billing close. Always the signed `restow` envelope (a
 * billing or PSA tool checks the signature); the secret behind `secretRef` is installation level.
 * Health columns as on `webhooks`. Managed by the provider's API keys (`/provider/webhooks`,
 * `webhooks:manage`) and under Installation › Provider API; the installation role's alone.
 */
export const providerWebhooks = pgTable(
  "provider_webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    name: text("name"),
    url: text("url").notNull(),
    secretRef: uuid("secret_ref").references(() => secrets.id, { onDelete: "set null" }),
    events: text("events").array().notNull().default(sql`'{}'::text[]`),
    active: boolean("active").notNull().default(true),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    failureAlertedAt: timestamp("failure_alerted_at", { withTimezone: true }),
    lastFailure: text("last_failure"),
    ...timestamps(),
  },
  (t) => [index("provider_webhooks_provider_idx").on(t.providerId)],
);

/**
 * One row per event delivery attempt series. `attempts` counts HTTP tries so
 * far; `lastError` keeps the most recent failure (status code or transport
 * error) for the operator; `nextAttemptAt` drives the retry backoff.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // A tenant webhook's delivery has its tenant and webhook; a provider webhook's (0.6.0) has
    // neither, only `provider_webhook_id` (webhook_deliveries_owner_ck). Tenant sessions never
    // see the provider's rows (their tenant_id is null, sql/rls.sql).
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    webhookId: uuid("webhook_id").references(() => webhooks.id, { onDelete: "cascade" }),
    providerWebhookId: uuid("provider_webhook_id").references(() => providerWebhooks.id, {
      onDelete: "cascade",
    }),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("webhook_deliveries_webhook_created_idx").on(t.webhookId, t.createdAt),
    index("webhook_deliveries_status_next_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliveries_provider_webhook_created_idx")
      .on(t.providerWebhookId, t.createdAt)
      .where(sql`${t.providerWebhookId} IS NOT NULL`),
    check(
      "webhook_deliveries_owner_ck",
      sql`(${t.tenantId} IS NOT NULL AND ${t.webhookId} IS NOT NULL AND ${t.providerWebhookId} IS NULL) OR (${t.tenantId} IS NULL AND ${t.webhookId} IS NULL AND ${t.providerWebhookId} IS NOT NULL)`,
    ),
  ],
);

export type Webhook = typeof webhooks.$inferSelect;
export type ProviderWebhook = typeof providerWebhooks.$inferSelect;
export type NewProviderWebhook = typeof providerWebhooks.$inferInsert;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatusEnum.enumValues)[number];
export type WebhookFormat = (typeof webhookFormatEnum.enumValues)[number];
