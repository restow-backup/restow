import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { snapshots } from "./backup.js";
import { protectedObjects } from "./sources.js";
import { tenants } from "./tenants.js";

/**
 * An object an admin confirmed as empty (0.4.9): its newest restore check found nothing to
 * restore (core verify/readiness.ts `snapshot_empty`: only default folders or system pages,
 * 0 bytes), and someone said "that is right, it is empty". While the newest check still says
 * exactly that, the object reads neutral grey ("empty") instead of yellow and counts for no
 * "needs attention" (apps/api verify/summary.ts). A later check that reads content back, or
 * finds any other reason, ends it: the worker deletes the row with that report (same
 * transaction), and the API ignores a row whose object's newest check says otherwise.
 *
 * One row per object; confirming again replaces it, revoking deletes it. Both are audited
 * (`verify.empty_confirmed`, `verify.empty_confirmation_revoked`). Its own table, apart from
 * `protected_objects.status_confirmed_*` (tied to `orphaned`) and the acknowledged warnings (tied
 * to failed backup items).
 */
export const emptyConfirmations = pgTable(
  "empty_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    // The backup the admin looked at; kept as a record when it is pruned later.
    snapshotId: uuid("snapshot_id").references(() => snapshots.id, { onDelete: "set null" }),
    note: text("note"),
    // better-auth identity of who confirmed; the label stays when the account is deleted.
    confirmedByUserId: text("confirmed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("empty_confirmations_tenant_idx").on(t.tenantId),
    uniqueIndex("empty_confirmations_object_uq").on(t.protectedObjectId),
    check("empty_confirmations_note_ck", sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`),
  ],
);

export type EmptyConfirmation = typeof emptyConfirmations.$inferSelect;
export type NewEmptyConfirmation = typeof emptyConfirmations.$inferInsert;
