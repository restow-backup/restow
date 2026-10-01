import { createRoute } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { STATS_VIEW, parseStatsSearch } from "@/features/stats";

import { DashboardPage } from "./dashboard-page.js";

/**
 * The overview is the default route of the authenticated shell. Its search
 * holds the tab (`view=statistics`) and the statistics' own period and scope.
 */
export const dashboardRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.view === STATS_VIEW ? { view: STATS_VIEW } : {}),
    ...parseStatsSearch(search),
  }),
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
