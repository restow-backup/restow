import { sql } from "drizzle-orm";
import {
  boolean,
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
 * lists the subscribed event names (e.g. "backup.completed", "restore.failed");
 * an empty list subscribes to nothing.
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
    ...timestamps(),
  },
  (t) => [index("webhooks_tenant_idx").on(t.tenantId)],
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
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
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
  ],
);

export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatusEnum.enumValues)[number];
export type WebhookFormat = (typeof webhookFormatEnum.enumValues)[number];
