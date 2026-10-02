import { createRoute } from "@tanstack/react-router";
import { History } from "lucide-react";
import { createElement } from "react";

import { HISTORY_PATH } from "@/features/jobs/paths";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n";
import { HISTORY_ROLES, HistoryRoute, RunDetailRoute } from "./route-pages";

/**
 * History (`/history`): every run of the tenant, from the server and from the agents, with the
 * live channel, the run drawer and the page of one run (`/history/<id>`, the target of the old
 * `/jobs/<run id>`). The job definitions are the feature backup-jobs; the integration API keeps
 * its names (`/api/v1/jobs` and `/api/v1/runs` are these runs).
 */

export const historyRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: HISTORY_PATH,
  // Keep every parameter: the tab, the job and the open run live in the address (see presenters.ts).
  validateSearch: (search: Record<string, unknown>) => search,
  component: HistoryRoute,
});

export const runDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: `${HISTORY_PATH}/$runId`,
  component: function RunDetailPath() {
    const { runId } = runDetailRoute.useParams();
    return createElement(RunDetailRoute, { runId });
  },
});

export const routes = [historyRoute, runDetailRoute];

export const navItems: NavItem[] = [
  {
    id: "history",
    path: HISTORY_PATH,
    labelKey: "backup:nav.history",
    icon: History,
    roles: [...HISTORY_ROLES],
    group: "daily",
    order: 10,
  },
];
