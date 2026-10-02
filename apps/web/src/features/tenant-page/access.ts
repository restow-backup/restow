import { useQuery } from "@tanstack/react-query";

import { type ProviderRole, setupStateQueryOptions } from "@/lib/api";
import { providerRoleSatisfies } from "@/lib/provider-role";
import { type SessionTenant, useSession } from "@/lib/session";
import { canEnterTenant } from "@/lib/tenant";

/**
 * Who may open a tenant's page, and what they may change there. Pure
 * decisions first, the hooks that feed them below.
 *
 * The page is for the admins of the tenant: provider admins (any tenant in
 * their scope) and the tenant's own administrators. A tenant admin sees their
 * own tenant only; the address of another tenant says so instead of failing.
 * An end user (a plain member) has no tenant page at all.
 */

export type TenantPageAccess =
  /** Open: the viewer administers the tenant. */
  | { kind: "ok"; tenant: SessionTenant }
  /** A provider admin asked for a tenant that does not exist, or lies outside their scope. */
  | { kind: "unknown" }
  /** Not a member of that tenant (and not a provider admin): it is somebody else's. */
  | { kind: "notYours" }
  /** A member, but not an administrator: end users have no tenant page. */
  | { kind: "notAdmin"; tenant: SessionTenant }
  /** Suspended or being deleted: closed to everyone but the provider. */
  | { kind: "closed"; tenant: SessionTenant };

export function resolveTenantPageAccess(input: {
  isProviderAdmin: boolean;
  tenants: readonly SessionTenant[];
  tenantId: string;
}): TenantPageAccess {
  const tenant = input.tenants.find((candidate) => candidate.id === input.tenantId);
  if (!tenant) {
    return { kind: input.isProviderAdmin ? "unknown" : "notYours" };
  }
  if (!input.isProviderAdmin && tenant.role !== "tenant_admin") {
    return { kind: "notAdmin", tenant };
  }
  if (!canEnterTenant(tenant.status, input.isProviderAdmin)) {
    return { kind: "closed", tenant };
  }
  return { kind: "ok", tenant };
}

/** Why the controls of the page are closed; null when the viewer may change settings. */
export type WriteBlock = "demo" | "role";

/**
 * Changing a tenant's settings needs, of a provider admin, the Administrator
 * role of the provider team (apps/api lib/provider-access.ts `configure`); the
 * tenant's own administrators may always change their tenant. The public demo
 * closes every change before a click.
 */
export function tenantWriteBlock(input: {
  demo: boolean;
  isProviderAdmin: boolean;
  providerRole: ProviderRole | null | undefined;
}): WriteBlock | null {
  if (input.demo) {
    return "demo";
  }
  if (
    input.isProviderAdmin &&
    !providerRoleSatisfies(input.providerRole ?? "owner", "administrator")
  ) {
    return "role";
  }
  return null;
}

/** What the signed-in viewer may do on the tenant page. */
export function useTenantWriteBlock(): WriteBlock | null {
  const session = useSession();
  const { data: setup } = useQuery(setupStateQueryOptions);
  return tenantWriteBlock({
    demo: setup?.demo.enabled === true,
    isProviderAdmin: session.isProviderAdmin,
    providerRole: session.providerRole,
  });
}
