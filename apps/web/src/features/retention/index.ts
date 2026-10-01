import { createRoute } from "@tanstack/react-router";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n.js";
import { RETENTION_PATH } from "./paths.js";
import { RetentionPage } from "./retention-page.js";

/**
 * Retention: how long backup restore points are kept, as a tenant default
 * plus per-object overrides on the tiered keep rule the worker's retention
 * handler enforces. Tenant-administrator only.
 */

export const retentionRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: RETENTION_PATH,
  component: RetentionPage,
});

export const routes = [retentionRoute];

/**
 * No menu entry of its own: the page is a tab of the tenant setup area
 * (features/tenant-setup), which the menu entry "Setup" or "Open tenant page"
 * opens.
 */
export const navItems: NavItem[] = [];
