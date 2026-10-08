import { createRoute } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { createElement } from "react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n";
import { useOpenWarningsBadge } from "./hooks";
import { WARNINGS_PATH, parseWarningsSearch } from "./paths";
import { WarningsRoute } from "./route-pages";

/**
 * Warnings (`/warnings`): backups that went through but left items behind, why, and their
 * acknowledgements (apps/api features/warnings). Its menu entry sits in Daily next to History
 * (features/registry.ts), for the roles that may read warnings (tenant and provider
 * administrators, as the API decides), with the number of open warnings of the active tenant.
 * Every warning badge leads here as well, or to the sheet of its object: the start page's
 * protected-objects tile, the backup column of the protected objects and the run view of History.
 */

/** Who may read the warnings (apps/api features/warnings routes: tenant administrators). */
export const WARNINGS_ROLES = ["provider_admin", "tenant_admin"] as const;

export const warningsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: WARNINGS_PATH,
  validateSearch: (search: Record<string, unknown>) => parseWarningsSearch(search),
  component: function WarningsPath() {
    const { state } = warningsRoute.useSearch();
    return createElement(WarningsRoute, { state });
  },
});

export const routes = [warningsRoute];

export const navItems: NavItem[] = [
  {
    id: "warnings",
    path: WARNINGS_PATH,
    labelKey: "warnings:nav",
    icon: TriangleAlert,
    roles: [...WARNINGS_ROLES],
    group: "daily",
    useBadge: useOpenWarningsBadge,
  },
];

export { WarningSheet } from "./components/warning-sheet";
export { AcknowledgeDialog } from "./components/acknowledge-dialog";
export { WARNINGS_PATH, warningsTo } from "./paths";
