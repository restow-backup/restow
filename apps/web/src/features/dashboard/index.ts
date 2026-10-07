import { createRoute, redirect } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import {
  ALL_TENANTS_STATS_PATH,
  STATS_VIEW,
  legacyProviderScope,
  parseStatsSearch,
} from "@/features/stats";

import { DashboardPage } from "./dashboard-page.js";

/**
 * The overview is the default route of the authenticated shell. Its search
 * holds the tab (`view=statistics`) and the statistics' period. The
 * statistics there are the active tenant's alone; an old link to the totals of
 * every tenant (`?view=statistics&scope=provider`) leads to their own page
 * with its period, replacing the history entry so Back does not bounce.
 */
export const dashboardRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.view === STATS_VIEW ? { view: STATS_VIEW } : {}),
    ...parseStatsSearch(search),
  }),
  beforeLoad: ({ location }) => {
    const raw = location.search as Record<string, unknown>;
    if (raw.view === STATS_VIEW && legacyProviderScope(raw)) {
      throw redirect({
        to: ALL_TENANTS_STATS_PATH as never,
        search: parseStatsSearch(raw) as never,
        replace: true,
      });
    }
  },
  component: DashboardPage,
});

export const routes = [dashboardRoute];

export const navItems: NavItem[] = [
  {
    id: "dashboard",
    path: "/",
    labelKey: "dashboard:nav",
    icon: LayoutDashboard,
    group: "daily",
    exact: true,
    order: 0,
  },
];
