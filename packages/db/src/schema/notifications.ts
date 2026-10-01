import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { tenants } from "./tenants.js";

export const notificationLevelEnum = pgEnum("notification_level", ["info", "warning", "error"]);

/**
 * In-app notifications (the bell). `event` is the machine name ("backup.failed",
 * "verify.red", "scrub.corrupt") that the UI maps to a translated string;
 * `message` is a plain-language fallback in English and `details` the
 * parameters (tenant, object, counts) for the translation. `tenantId` null
 * means installation-wide (provider admins only). `readAt` marks it as seen.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    level: notificationLevelEnum("level").notNull().default("info"),
    event: text("event").notNull(),
    message: text("message").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [index("notifications_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationLevel = (typeof notificationLevelEnum.enumValues)[number];
