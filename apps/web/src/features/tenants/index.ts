import { createRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { createElement } from "react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n";
import { INVITATIONS_PATH, TENANTS_PATH } from "./paths";
import { parseTenantsSearch } from "./presenters";
import { InvitationRoutePage, TENANT_MANAGEMENT_ROLES, TenantsRoutePage } from "./route-pages";

/**
 * Tenants feature: the provider's tenant management (list with mailbox
 * usage, protection and readiness; create, switch into, delete) and the page an
 * invited person opens to accept. One tenant's own page, with its overview,
 * members, master data and every other setting, is the tenant page
 * (features/tenant-page); the old address of the members page, `/members`,
 * leads there (features/redirects).
 */

export const tenantsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: TENANTS_PATH,
  // `?new=1` opens the "+ New tenant" wizard on arrival (the command palette
  // and any other link use this instead of a per-page action registry).
  validateSearch: (search: Record<string, unknown>) => parseTenantsSearch(search),
  component: TenantsRoutePage,
});

export const invitationRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: `${INVITATIONS_PATH}/$invitationId`,
  component: function InvitationRoute() {
    const { invitationId } = invitationRoute.useParams();
    return createElement(InvitationRoutePage, { invitationId });
  },
});

export const routes = [tenantsRoute, invitationRoute];

export const navItems: NavItem[] = [
  {
    // "All tenants": the list, never the tenants themselves (they would
    // overload the menu; 0.2.0 adds pins). The settings of the active tenant
    // have their own entry before it (features/tenant-page).
    id: "tenants",
    path: TENANTS_PATH,
    labelKey: "tenants:nav.tenants",
    icon: Building2,
    roles: [...TENANT_MANAGEMENT_ROLES],
    group: "tenants",
    // After the tenant settings entry.
    order: 50,
  },
];
