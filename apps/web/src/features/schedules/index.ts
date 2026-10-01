import { createRoute } from "@tanstack/react-router";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n.js";
import { SCHEDULES_PATH } from "./paths.js";
import { SchedulesPage } from "./schedules-page.js";

/**
 * Schedules: what runs unattended per tenant (backup, verification, scrub,
 * directory sync, retention), with the recommended set, next and last runs
 * and honest warnings when backups run only by hand or stay unverified.
 * Every member of the tenant sees the page; only administrators change it.
 */

export const schedulesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: SCHEDULES_PATH,
  component: SchedulesPage,
});

export const routes = [schedulesRoute];

/**
 * No menu entry of its own: the page is a tab of the tenant setup area
 * (features/tenant-setup), which the menu entry "Setup" or "Open tenant page"
 * opens.
 */
export const navItems: NavItem[] = [];
