import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { tenants } from "./tenants.js";

/**
 * API keys for RMM/PSA integrations (docs/ARCHITECTURE.md, API). A key is shown
 * exactly once at creation; only `prefix` (the public `rsk_...` identifier used
 * for lookup) and `keyHash` (SHA-256 of the full token) are stored. Tenant keys
 * carry a `tenantId`; a provider key (cross-tenant reads, offered only when an
 * extension enables it) has `tenantId` null and is therefore only visible to the provider role.
 * Revocation is soft (`revokedAt`) so the audit trail keeps the key identity.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Public, non-secret identifier part of the token (e.g. "rsk_a1b2c3d4").
    prefix: text("prefix").notNull(),
    // Hex SHA-256 of the full presented token. The token itself is never stored.
    keyHash: text("key_hash").notNull(),
    // Granted scopes, e.g. "status:read", "restore:write" (see apps/api API_SCOPES).
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("api_keys_prefix_uq").on(t.prefix),
    uniqueIndex("api_keys_key_hash_uq").on(t.keyHash),
    index("api_keys_tenant_idx").on(t.tenantId),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
