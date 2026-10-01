import { type TenantStatus, tenants } from "@restow/db";
import { asc, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, providerDb } from "../db.js";
import { sessionFieldContributions } from "../extensions.js";
import { type GatedFeature, enabledFeatures } from "../lib/features.js";
import {
  type ProviderAccess,
  type ProviderRole,
  providerMayEnterTenant,
} from "../lib/provider-access.js";
import {
  type Role,
  type TenantRole,
  globalRole,
  tenantRoleFromMembership,
} from "../middleware/rbac.js";
import { type Membership, type SessionEnv, requireSession } from "../middleware/session.js";
import { versionSource } from "./v1.js";
import type { VersionInfo } from "./v1/version.js";

/**
 * GET /api/v1/me — who am I, which tenants can I see, with which role.
 *
 * Provider admins see every tenant (they administer all of them); everybody
 * else sees the tenants whose organization they are a member of. The active
 * tenant follows the session's active organization, when it maps to a tenant.
 *
 * Each tenant carries its status, so the tenant switcher can show a suspended
 * tenant as such instead of letting a member run into refused requests. The
 * running version is the same document `/api/v1/status` reports; the shell
 * shows it in the sidebar footer. `features` lists the gated core functions
 * that are on (lib/features.ts) and `extensions` carries what registered
 * extensions add to the session (extensions.ts `sessionFields`), passed
 * through unread.
 */

export const me = new Hono<SessionEnv>();

interface MeTenantDto {
  id: string;
  name: string;
  slug: string;
  /** The user's role in this tenant (provider admins administer every tenant). */
  role: TenantRole;
  /** `suspended` and `deleting` tenants refuse everyone but provider admins. */
  status: TenantStatus;
}

export interface MeResponse {
  user: { id: string; name: string; email: string };
  /** The highest role across all tenants; gates use the role in the active tenant. */
  role: Role;
  tenants: MeTenantDto[];
  activeTenantId: string | null;
  /** The gated core functions that are on right now; empty without an extension enabling them. */
  features: GatedFeature[];
  /** Fields contributed by extensions, by key. */
  extensions: Record<string, unknown>;
  version: VersionInfo;
  /**
   * A provider admin's role in the provider team and whether it covers every
   * tenant (lib/provider-access.ts); null for everyone else. The UI hides
   * what the role does not allow; the API refuses it either way.
   */
  provider: { role: ProviderRole; allTenants: boolean } | null;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  organizationId: string | null;
}

const tenantColumns = {
  id: tenants.id,
  name: tenants.name,
  slug: tenants.slug,
  status: tenants.status,
  organizationId: tenants.organizationId,
};

/**
 * The tenants a user may switch to. This spans tenants by nature, so it runs
 * on the installation pool; the rows are narrowed to the user's memberships
 * right here, and nothing but names, ids and states leaves this function.
 */
async function visibleTenants(
  isProviderAdmin: boolean,
  providerAccess: ProviderAccess | null,
  memberships: Membership[],
): Promise<TenantRow[]> {
  if (isProviderAdmin) {
    const all = await providerDb.select(tenantColumns).from(tenants).orderBy(asc(tenants.name));
    // A provider admin limited to some tenants sees only those.
    return providerAccess
      ? all.filter((row) => providerMayEnterTenant(providerAccess, row.id))
      : all;
  }
  const organizationIds = memberships.map((m) => m.organizationId);
  if (organizationIds.length === 0) {
    return [];
  }
  return providerDb
    .select(tenantColumns)
    .from(tenants)
    .where(inArray(tenants.organizationId, organizationIds))
    .orderBy(asc(tenants.name));
}

/** The role a user holds in one tenant; provider admins administer every tenant. */
function roleIn(
  tenant: TenantRow,
  isProviderAdmin: boolean,
  memberships: Membership[],
): TenantRole {
  if (isProviderAdmin) {
    return "tenant_admin";
  }
  const membership = memberships.find((m) => m.organizationId === tenant.organizationId);
  return tenantRoleFromMembership(membership?.role);
}

/** Every registered session field, loaded side by side. */
async function extensionFields(
  userId: string,
  isProviderAdmin: boolean,
): Promise<Record<string, unknown>> {
  const fields = sessionFieldContributions();
  const values = await Promise.all(
    fields.map((field) => field.load({ db: providerDb, userId, isProviderAdmin })),
  );
  return Object.fromEntries(fields.map((field, index) => [field.key, values[index]]));
}

me.get("/", requireSession, async (c) => {
  const user = c.get("user");
  const isProviderAdmin = c.get("isProviderAdmin");
  const memberships = c.get("memberships");
  const activeOrganizationId = c.get("auth").session.activeOrganizationId ?? null;

  const providerAccess = c.get("providerAccess");
  const rows = await visibleTenants(isProviderAdmin, providerAccess, memberships);
  const body: MeResponse = {
    user: { id: user.id, name: user.name, email: user.email },
    role: globalRole(
      user.role,
      memberships.map((m) => m.role),
    ),
    tenants: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      role: roleIn(row, isProviderAdmin, memberships),
      status: row.status,
    })),
    activeTenantId:
      rows.find((row) => row.organizationId !== null && row.organizationId === activeOrganizationId)
        ?.id ?? null,
    features: await enabledFeatures(db),
    extensions: await extensionFields(user.id, isProviderAdmin),
    version: versionSource.current(),
    provider:
      isProviderAdmin && providerAccess
        ? { role: providerAccess.role, allTenants: providerAccess.allTenants }
        : null,
  };
  return c.json(body);
});
