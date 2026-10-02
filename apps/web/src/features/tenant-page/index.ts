import { createRoute, redirect } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { createElement } from "react";

import "@/features/tenant-page/i18n";
import type { NavItem } from "@/lib/navigation";
import { DEFAULT_TENANT_SECTION, tenantPagePath } from "@/lib/tenant-paths";
import { appLayoutRoute } from "@/routes/tree";

import {
  ORGANISATION_SETTINGS_NAV_ID,
  TENANT_PAGE_MATCH,
  TENANT_SETTINGS_NAV_ID,
  TENANT_SETTINGS_PATH,
} from "@/lib/tenant-nav";
import { SUB_PAGES, type SubPage } from "./presenters";
import { tenantSections } from "./sections";
import { TenantPage } from "./tenant-page";

export {
  ORGANISATION_SETTINGS_NAV_ID,
  TENANT_SETTINGS_NAV_ID,
  TENANT_SETTINGS_NAV_IDS,
  withActiveTenant,
} from "@/lib/tenant-nav";

/**
 * The tenant page feature: `/tenants/<id>/<section>` with a sub-navigation
 * (Overview, Connections, Protection, Jobs & schedules, Backup retention,
 * Storage, Agents, Archive, Notifications, Integrations, Members, Audit log
 * and Master data), the menu entry "Tenant settings" ("Settings" of the one
 * organisation) that opens it for the active tenant, and the pages below a
 * section that have an address of their own (a source, the import wizard and an
 * import, the per-object backup, a webhook). It replaces the provider's tenant
 * detail page and the tabs of the former setup area; the old addresses lead
 * here (features/redirects).
 */

/** Everyone who administers a tenant: provider admins and the tenant's own administrators. */
export const TENANT_PAGE_ROLES = ["provider_admin", "tenant_admin"] as const;

/** The route's search is read by the section that shows it; anything is let through. */
function passSearch(search: Record<string, unknown>): Record<string, unknown> {
  return search;
}

/** `/tenants/<id>` leads to the first section. */
export const tenantIndexRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/tenants/$tenantId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: tenantPagePath(params.tenantId, DEFAULT_TENANT_SECTION) as never,
      replace: true,
    });
  },
  // Never rendered: the guard always leaves.
  component: () => null,
});

export const tenantSectionRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/tenants/$tenantId/$section",
  validateSearch: passSearch,
  beforeLoad: ({ params }) => {
    // An address no section answers to (a section of an extension that is not part of this build).
    if (!tenantSections().some((section) => section.id === params.section)) {
      throw redirect({
        to: tenantPagePath(params.tenantId, DEFAULT_TENANT_SECTION) as never,
        replace: true,
      });
    }
  },
  component: function TenantSectionRoute() {
    const { tenantId, section } = tenantSectionRoute.useParams();
    return createElement(TenantPage, { tenantId, section });
  },
});

/** A page below a section that has an address of its own. */
function subRoute(path: string, section: string, sub: SubPage) {
  const route = createRoute({
    getParentRoute: () => appLayoutRoute,
    path,
    validateSearch: passSearch,
    component: function TenantSubRoute() {
      const { tenantId } = route.useParams() as { tenantId: string };
      return createElement(TenantPage, { tenantId, section, sub });
    },
  });
  return route;
}

export const sourceRoute = subRoute(
  "/tenants/$tenantId/connections/sources/$sourceId",
  "connections",
  SUB_PAGES.source,
);
// Static, so it wins over `imports/$importId`.
export const importWizardRoute = subRoute(
  "/tenants/$tenantId/connections/imports/new",
  "connections",
  SUB_PAGES.importWizard,
);
export const importRoute = subRoute(
  "/tenants/$tenantId/connections/imports/$importId",
  "connections",
  SUB_PAGES.importDetail,
);
export const backupRoute = subRoute(
  "/tenants/$tenantId/protection/backup",
  "protection",
  SUB_PAGES.backup,
);
export const webhookRoute = subRoute(
  "/tenants/$tenantId/integrations/webhooks/$webhookId",
  "integrations",
  SUB_PAGES.webhook,
);

export const routes = [
  tenantIndexRoute,
  tenantSectionRoute,
  sourceRoute,
  importWizardRoute,
  importRoute,
  backupRoute,
  webhookRoute,
];

/**
 * "Tenant settings" in the menu section Tenants, and "Settings" in the section
 * of the one organisation: it opens the overview of the active tenant's page
 * and stays highlighted on every section. Provider admins and a tenant's own
 * administrators (in a Service Provider installation too); end users have no
 * such page. The gear next to the tenant switcher leads to the same place.
 */
export const navItems: NavItem[] = [
  {
    id: TENANT_SETTINGS_NAV_ID,
    path: TENANT_SETTINGS_PATH,
    matches: [TENANT_PAGE_MATCH],
    labelKey: "nav.items.tenantSettings",
    icon: Settings,
    roles: [...TENANT_PAGE_ROLES],
    group: "tenants",
    order: 10,
    visible: (context) => (context.features ?? []).includes("tenants.additional"),
  },
  {
    id: ORGANISATION_SETTINGS_NAV_ID,
    path: TENANT_SETTINGS_PATH,
    matches: [TENANT_PAGE_MATCH],
    labelKey: "nav.items.organisationSettings",
    icon: Settings,
    roles: [...TENANT_PAGE_ROLES],
    group: "tenants",
    order: 10,
    visible: (context) => !(context.features ?? []).includes("tenants.additional"),
  },
];
