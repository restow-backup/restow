import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { endpoints } from "./endpoints.js";
import { protectedObjects } from "./sources.js";
import { tenants } from "./tenants.js";

/**
 * An acknowledged warning of a protected object (mailbox, OneDrive, IMAP account) or a machine
 * (packages/core/src/failures/warnings.ts). A warning is a backup that went through but left
 * items behind; acknowledging it says "seen, accepted" for the causes it had (`causes`), with an
 * optional note. While the newest run of the object has no other cause and no run failed
 * outright since `acknowledged_at`, the warning does not count in the overview, the status API
 * or the directory badges. A failed backup is never covered.
 *
 * One row per object or machine (the partial unique indexes); acknowledging again replaces it,
 * revoking deletes it. Both are audited (`warning.acknowledged`, `warning.acknowledgement_revoked`)
 * so the history stays in the audit log.
 */
export const warningAcknowledgements = pgTable(
  "warning_acknowledgements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id").references(() => protectedObjects.id, {
      onDelete: "cascade",
    }),
    endpointId: uuid("endpoint_id").references(() => endpoints.id, { onDelete: "cascade" }),
    // The cause codes the acknowledgement covers ("unknown" for items without a classified cause).
    causes: text("causes").array().notNull().default(sql`'{}'::text[]`),
    // The run that was looked at (a mail job or a machine run); no foreign key, it is one of two tables.
    runId: uuid("run_id"),
    note: text("note"),
    // better-auth identity of who acknowledged; the label stays when the account is deleted.
    acknowledgedByUserId: text("acknowledged_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    acknowledgedBy: text("acknowledged_by").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("warning_acknowledgements_tenant_idx").on(t.tenantId),
    uniqueIndex("warning_acknowledgements_object_uq")
      .on(t.protectedObjectId)
      .where(sql`${t.protectedObjectId} IS NOT NULL`),
    uniqueIndex("warning_acknowledgements_endpoint_uq")
      .on(t.endpointId)
      .where(sql`${t.endpointId} IS NOT NULL`),
    check(
      "warning_acknowledgements_one_target_ck",
      sql`(${t.protectedObjectId} IS NOT NULL) <> (${t.endpointId} IS NOT NULL)`,
    ),
    check(
      "warning_acknowledgements_note_ck",
      sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`,
    ),
  ],
);

export type WarningAcknowledgement = typeof warningAcknowledgements.$inferSelect;
export type NewWarningAcknowledgement = typeof warningAcknowledgements.$inferInsert;
