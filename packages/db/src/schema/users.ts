import { pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { tenants } from "./tenants.js";

/**
 * Roles. `provider_admin` is installation-wide (tenant_id null); `tenant_admin`
 * (including an Entra Global Admin arriving via SSO) and `tenant_user` are scoped
 * to a single tenant.
 */
export const roleEnum = pgEnum("role", ["provider_admin", "tenant_admin", "tenant_user"]);

/**
 * Directory of people whose mailboxes / OneDrives Restow protects. Populated by
 * Entra ID sync (Graph users/delta) for M365 tenants, or by manual list / CSV
 * for IMAP tenants. `tenant_id` is null only for installation-level accounts.
 *
 * NOTE: the interactive login identities (passkey/session/etc.) live in the
 * better-auth tables (see src/schema/index.ts) and tenant roles come from
 * better-auth organization membership. This table is the protection directory
 * only; `user_roles` records directory-level role hints (e.g. an Entra Global
 * Admin discovered by sync) and never grants access by itself.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    // Entra ID object id for M365-synced users; null for manual/IMAP users.
    entraObjectId: text("entra_object_id"),
    email: text("email").notNull(),
    // User principal name (Entra) where available.
    upn: text("upn"),
    displayName: text("display_name"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("users_tenant_email_uq").on(t.tenantId, t.email)],
);

/**
 * Role assignments. A user may hold a tenant role in several tenants; a
 * provider admin holds `provider_admin` with a null tenant_id.
 */
export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("user_roles_user_tenant_role_uq").on(t.userId, t.tenantId, t.role)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
export type Role = (typeof roleEnum.enumValues)[number];
