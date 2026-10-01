import { createRoute } from "@tanstack/react-router";
import { BellRing } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { REPORTS_PATH } from "./paths.js";
import { REPORTS_ROLES } from "./presenters.js";
import { ReportsPage } from "./reports-page.js";

/**
 * Alerts: rules that send an alert when something happens or a summary
 * report at a point in time (where the installation enables
 * `reports.timed`), by e-mail, to the bell or to a webhook, and the log of
 * every delivery.
 */

export const reportsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: REPORTS_PATH,
  component: ReportsPage,
});

export const routes = [reportsRoute];

export const navItems: NavItem[] = [
  {
    id: "alerts",
    path: REPORTS_PATH,
    labelKey: "reports:nav",
    icon: BellRing,
    roles: [...REPORTS_ROLES],
    group: "daily",
    order: 30,
  },
];
