import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { protectedObjects } from "./sources.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/** The role a person holds in a Microsoft 365 group (and so in its group-connected site). */
export const MEMBERSHIP_ROLES = ["owner", "member"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * Who belongs to a Microsoft 365 group mailbox or a SharePoint site (#89), so the restore
 * explorer lists a person's Teams and sites under their entry. The directory sync fills it
 * (apps/worker handlers/directory.ts, core directory/memberships.ts) from
 * `/groups/{id}/owners` and `/groups/{id}/members`; a group-connected site
 * (`/groups/{id}/sites/root`) gets the same rows as its group. Communication sites without a
 * group have no rows: Graph v1.0 does not expose their SharePoint groups (docs/MICROSOFT.md).
 *
 * One row per object and person; `owner` wins when Graph lists someone as both (owners of a
 * Microsoft 365 group are usually members as well). A group whose membership was read gets its
 * rows replaced in one transaction: a person who left loses the row. Rows of a group or site
 * that was deleted at the source stay as last known (its restore points stay too), and go with
 * the object or the person (ON DELETE CASCADE).
 */
export const directoryMemberships = pgTable(
  "directory_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull(),
    ...timestamps(),
  },
  (t) => [
    // One row per object and person; it also serves the object side (the sync's replace per
    // group, the ON DELETE CASCADE of `protected_objects`).
    uniqueIndex("directory_memberships_object_user_uq").on(t.protectedObjectId, t.userId),
    // A person's memberships (the explorer's "Teams & sites", one query per page) and the
    // ON DELETE CASCADE of `users`, both by user first.
    index("directory_memberships_user_idx").on(t.userId, t.protectedObjectId),
    check("directory_memberships_role_ck", sql`${t.role} IN ('owner', 'member')`),
  ],
);

export type DirectoryMembershipRow = typeof directoryMemberships.$inferSelect;
export type NewDirectoryMembershipRow = typeof directoryMemberships.$inferInsert;
