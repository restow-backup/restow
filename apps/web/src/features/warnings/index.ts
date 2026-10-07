import { createRoute } from "@tanstack/react-router";
import { createElement } from "react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n";
import { WARNINGS_PATH, parseWarningsSearch } from "./paths";
import { WarningsRoute } from "./route-pages";

/**
 * Warnings (`/warnings`): backups that went through but left items behind, why, and their
 * acknowledgements (apps/api features/warnings). The page has no menu entry of its own (the
 * menu of 0.2.0 is fixed); every warning badge leads here or to the sheet of its object: the
 * start page's protected-objects tile, the backup column of the protected objects and the run
 * view of History.
 */

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

export const navItems: NavItem[] = [];

export { WarningSheet } from "./components/warning-sheet";
export { AcknowledgeDialog } from "./components/acknowledge-dialog";
export { WARNINGS_PATH, warningsTo } from "./paths";
