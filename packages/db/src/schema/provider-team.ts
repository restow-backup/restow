import { boolean, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { tenants } from "./tenants.js";

/**
 * The provider's own team (data model of the ee/ provider team module): what
 * each provider admin may do, and in which tenants.
 * A provider admin is still marked by better-auth's `user.role = "admin"`
 * (apps/api middleware/rbac.ts); this table narrows that down. A provider
 * admin without a row here is an owner, which is what every installation
 * had before the team existed (the setup wizard's first admin).
 *
 *   owner          everything, including the team and the installation's own
 *                  settings
 *   administrator  configures and operates tenants, storage, schedules,
 *                  sources and integrations; not the team or the
 *                  installation settings
 *   technician     operates: backups, verification, restores, browsing
 *                  backed-up and archived content; changes no configuration
 *   read_only      sees status, reports and the audit log; no content, no
 *                  changes
 *
 * The rules per API route live in apps/api/src/lib/provider-access.ts.
 */
export const providerRoleEnum = pgEnum("provider_role", [
  "owner",
  "administrator",
  "technician",
  "read_only",
]);

export const providerMembers = pgTable("provider_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  role: providerRoleEnum("role").notNull(),
  /** Every tenant, now and future; otherwise only those in provider_member_tenants. */
  allTenants: boolean("all_tenants").notNull().default(true),
  /** Who added this member; null for the first admin and for a deleted inviter. */
  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
  ...timestamps(),
});

export const providerMemberTenants = pgTable(
  "provider_member_tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => providerMembers.userId, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("provider_member_tenants_user_tenant_uq").on(t.userId, t.tenantId)],
);

export type ProviderMember = typeof providerMembers.$inferSelect;
export type ProviderRole = (typeof providerRoleEnum.enumValues)[number];
