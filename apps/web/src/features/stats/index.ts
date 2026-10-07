import { createRoute } from "@tanstack/react-router";
import { ChartColumnStacked } from "lucide-react";

import type { NavItem, NavLockContext } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { ALL_TENANTS_STATS_ROLES } from "./hooks.js";
import { ALL_TENANTS_STATS_PATH, parseStatsSearch } from "./period.js";
import { AllTenantsStatsPage } from "./stats-page.js";
import "./i18n.js";

/**
 * Statistics feature: key figures, trends and tables of one period against
 * the previous one, with CSV exports per dataset and a PDF report.
 *
 * Overview › Statistics (features/dashboard, `/?view=statistics`) shows the
 * active tenant and nothing else, for its administrators and provider admins.
 * The statistics of all tenants are a page of their own,
 * `/statistics/all`, in the Installation section of the menu: for provider
 * admins whose team role covers every tenant, where the installation enables
 * `stats.allTenants` (Service Provider). Installations without it (Community and
 * Business, which have one organisation) do not show the entry at all; an old
 * link `?view=statistics&scope=provider` leads to the page (features/dashboard),
 * the old address `/stats` to whichever of the two it asked for
 * (features/redirects).
 */

export { ALL_TENANTS_STATS_ROLES, STATS_ROLES, mayViewAllTenantsStats } from "./hooks.js";
export {
  ALL_TENANTS_STATS_PATH,
  STATS_VIEW,
  legacyProviderScope,
  parseStatsSearch,
} from "./period.js";
export { AllTenantsStatsPage, StatsPage } from "./stats-page.js";

export const allTenantsStatsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: ALL_TENANTS_STATS_PATH,
  validateSearch: (search: Record<string, unknown>) => parseStatsSearch(search),
  component: AllTenantsStatsPage,
});

export const routes = [allTenantsStatsRoute];

/**
 * Whether the installation offers the statistics of all tenants to this
 * session: the gated feature, and a provider team role that covers every tenant
 * (the role itself is the entry's `roles`). Hidden rather than locked: without
 * the feature the installation has one organisation, and its statistics are
 * Overview › Statistics.
 */
export function offersAllTenantsStats(context: NavLockContext): boolean {
  return (
    (context.features ?? []).includes("stats.allTenants") && context.providerAllTenants !== false
  );
}

export const navItems: NavItem[] = [
  {
    id: "stats-all-tenants",
    path: ALL_TENANTS_STATS_PATH,
    labelKey: "stats:navAllTenants",
    icon: ChartColumnStacked,
    roles: ALL_TENANTS_STATS_ROLES,
    group: "installation",
    order: 5,
    visible: offersAllTenantsStats,
  },
];
