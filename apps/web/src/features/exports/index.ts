import { createRoute } from "@tanstack/react-router";
import { FileDown } from "lucide-react";
import { type ReactElement, createElement } from "react";

import { ExportPage } from "@/features/exports/export-page";
import { ExportsPage } from "@/features/exports/exports-page";
import { EXPORT_PATHS } from "@/features/exports/navigation";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n.js";

/**
 * Exports: mail leaves Restow as files (EML in a ZIP, MBOX, MSG in a ZIP)
 * that the person downloads within 24 hours. The export dialog is opened from
 * the restore explorer and the archive; this feature owns the export page
 * (live progress, the result, what could not be exported) and the history.
 */

export const exportsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: EXPORT_PATHS.list,
  component: ExportsPage,
});

export const exportRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: EXPORT_PATHS.detail,
  component: ExportRoute,
});

function ExportRoute(): ReactElement {
  const { exportId } = exportRoute.useParams();
  return createElement(ExportPage, { exportId });
}

export const routes = [exportsRoute, exportRoute];

export const navItems: NavItem[] = [
  {
    id: "exports",
    path: EXPORT_PATHS.list,
    labelKey: "exports:nav",
    icon: FileDown,
    // Like restore: end users export their own mailbox, admins everything of the tenant.
    roles: ["provider_admin", "tenant_admin", "tenant_user"],
    group: "mail",
    order: 40,
  },
];
