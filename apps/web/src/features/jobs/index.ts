import { createRoute } from "@tanstack/react-router";
import { History } from "lucide-react";
import { createElement } from "react";

import "@/features/jobs/i18n";
import {
  BackupRoutePage,
  JobDetailRoutePage,
  JobsRoutePage,
  OPERATOR_ROLES,
} from "@/features/jobs/pages/route-pages";
import { BACKUP_PATH, HISTORY_PATH } from "@/features/jobs/paths";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

/**
 * Runs: History with every run and its live progress, the page of one run
 * with its failures, and the per-object backup page with "Back up now"
 * (reached from Setup › Protection; see pages/route-pages.tsx for access).
 */

export const backupRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: BACKUP_PATH,
  component: BackupRoutePage,
});

export const historyRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: HISTORY_PATH,
  component: JobsRoutePage,
});

export const runDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: `${HISTORY_PATH}/$jobId`,
  component: function RunDetailRoute() {
    const { jobId } = runDetailRoute.useParams();
    return createElement(JobDetailRoutePage, { jobId });
  },
});

export const routes = [backupRoute, historyRoute, runDetailRoute];

export const navItems: NavItem[] = [
  {
    id: "history",
    path: HISTORY_PATH,
    labelKey: "backup:nav.history",
    icon: History,
    roles: [...OPERATOR_ROLES],
    group: "daily",
    order: 10,
  },
];
