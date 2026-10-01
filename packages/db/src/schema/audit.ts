import { date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdOnly } from "./_shared.js";
import { tenants } from "./tenants.js";

/**
 * Append-only audit log with a per-tenant hash chain. A database trigger forbids
 * UPDATE and DELETE (see sql/rls.sql), so there is intentionally no `updated_at`.
 * `chainHash = SHA-256(prev_hash || event-fields)`; a daily anchor is written to
 * `audit_anchor`. Events: login, consent, restore, impersonation, export,
 * retention deletion, legal hold, key access, license change.
 *
 * `tenantId` is nullable: some events (license change, provider login) are
 * installation-level and have no tenant. `actorUserId` is the better-auth
 * identity (`user.id`) of whoever acted, deliberately without a foreign key:
 * the log is immutable and must outlive the account, and any ON DELETE action
 * would be an UPDATE/DELETE the append-only trigger rejects. `actor` is the
 * human-readable label (email, "system", or an API-key prefix).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
    // Human/system actor label (e.g. email, "system", api-key prefix).
    actor: text("actor").notNull(),
    // better-auth user id; no FK on purpose (see above).
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    // What was acted on, and its type (mailbox, snapshot, archive_item, ...).
    target: text("target"),
    targetType: text("target_type"),
    // On whose behalf (impersonation), when different from the actor.
    onBehalfOf: text("on_behalf_of"),
    // Client IP (inet-compatible text) the action came from.
    ip: text("ip"),
    // Structured event details (counts, selection, reason). Never secrets.
    details: jsonb("details").$type<Record<string, unknown>>(),
    prevHash: text("prev_hash"),
    chainHash: text("chain_hash").notNull(),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex("audit_log_tenant_chain_hash_uq").on(t.tenantId, t.chainHash),
    index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

/** Daily anchor of the audit hash chain (date, last chain value, item count). */
export const auditAnchor = pgTable(
  "audit_anchor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
    anchorDate: date("anchor_date").notNull(),
    lastHash: text("last_hash").notNull(),
    count: integer("count").notNull().default(0),
    ...createdOnly(),
  },
  (t) => [uniqueIndex("audit_anchor_tenant_date_uq").on(t.tenantId, t.anchorDate)],
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type AuditAnchor = typeof auditAnchor.$inferSelect;
export type NewAuditAnchor = typeof auditAnchor.$inferInsert;
