import { createRoute } from "@tanstack/react-router";
import { Building2, Users } from "lucide-react";
import { createElement } from "react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n";
import { INVITATIONS_PATH, MEMBERS_PATH, TENANTS_PATH } from "./paths";
import { parseTenantsSearch } from "./presenters";
import {
  InvitationRoutePage,
  MembersRoutePage,
  TENANT_MANAGEMENT_ROLES,
  TenantDetailRoutePage,
  TenantsRoutePage,
} from "./route-pages";

/**
 * Tenants feature: the provider's tenant management (list with mailbox
 * usage, protection and readiness; create, switch into, edit, suspend,
 * delete; members and invitations per tenant), a members page for a
 * tenant's own admins, and the page an invited person opens to accept.
 */

export const tenantsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: TENANTS_PATH,
  // `?new=1` opens the "+ New tenant" wizard on arrival (the command palette
  // and any other link use this instead of a per-page action registry).
  validateSearch: (search: Record<string, unknown>) => parseTenantsSearch(search),
  component: TenantsRoutePage,
});

export const tenantDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: `${TENANTS_PATH}/$tenantId`,
  component: function TenantDetailRoute() {
    const { tenantId } = tenantDetailRoute.useParams();
    return createElement(TenantDetailRoutePage, { tenantId });
  },
});

export const membersRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: MEMBERS_PATH,
  component: MembersRoutePage,
});

export const invitationRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: `${INVITATIONS_PATH}/$invitationId`,
  component: function InvitationRoute() {
    const { invitationId } = invitationRoute.useParams();
    return createElement(InvitationRoutePage, { invitationId });
  },
});

export const routes = [tenantsRoute, tenantDetailRoute, membersRoute, invitationRoute];

export const navItems: NavItem[] = [
  {
    // "All tenants": the list, never the tenants themselves (they would
    // overload the menu; 0.2.0 adds pins). An installation with one tenant
    // shows "Setup" next to it (features/tenant-setup).
    id: "tenants",
    path: TENANTS_PATH,
    labelKey: "tenants:nav.tenants",
    icon: Building2,
    roles: [...TENANT_MANAGEMENT_ROLES],
    group: "tenants",
    order: 10,
  },
  {
    id: "tenant-members",
    path: MEMBERS_PATH,
    labelKey: "tenants:nav.members",
    icon: Users,
    // Provider admins manage members on the tenant pages; this entry is for
    // a tenant's own admins.
    roles: ["tenant_admin"],
    group: "admin",
    // Where provider admins see Team.
    order: 60,
  },
];
