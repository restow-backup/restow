import { createRoute } from "@tanstack/react-router";
import { type ReactElement, createElement } from "react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";
import "./i18n";
import { ImportJobPage } from "./jobs/import-job-page";
import { ImportsPage } from "./jobs/imports-page";
import { IMPORT_PATHS } from "./paths";
import { ImportWizardPage } from "./wizard/import-wizard-page";

/**
 * Mail file import: a wizard that brings EML, MSG, MBOX and ZIP files (also
 * MailStore exports as EML or MSG) into Restow as an imported mailbox, the
 * history of imports and one page per import with its live progress and report.
 * The wizard opens from Sources > Add source > "Import mail files".
 */

/** Static, so it wins over `/sources/$sourceId`. */
export const wizardRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: IMPORT_PATHS.wizard,
  component: ImportWizardPage,
});

export const listRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: IMPORT_PATHS.list,
  component: ImportsPage,
});

export const detailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: IMPORT_PATHS.detail,
  component: ImportJobRoute,
});

function ImportJobRoute(): ReactElement {
  const { importId } = detailRoute.useParams();
  return createElement(ImportJobPage, { importId });
}

export const routes = [wizardRoute, listRoute, detailRoute];

/**
 * No menu entry of its own: the page is a tab of the tenant setup area
 * (features/tenant-setup), which the menu entry "Setup" or "Open tenant page"
 * opens.
 */
export const navItems: NavItem[] = [];
