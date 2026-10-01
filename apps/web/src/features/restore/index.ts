import { createRoute, useSearch } from "@tanstack/react-router";
import { MailSearch } from "lucide-react";
import { type ReactElement, createElement } from "react";

import { ExplorerPage } from "@/features/restore/explorer/explorer-page";
import { RestoreJobPage } from "@/features/restore/jobs/job-page";
import { RestoreJobsPage } from "@/features/restore/jobs/jobs-page";
import { parseExplorerSearch } from "@/features/restore/lib/explorer-search";
import { RESTORE_PATHS, restoreTabOf } from "@/features/restore/navigation";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

/**
 * Restore: the restore explorer over snapshots (browse any point in time,
 * select folders, files and mails, see versions, restore or download) with
 * the tab "Recent restores" (`?tab=recent`): every restore with live progress
 * and per-item results, and one page per restore. End users see and restore
 * their own mailbox and OneDrive and follow their own restores; admins
 * everything of the tenant, with a reason for other people's data. The old
 * list address `/restore/jobs` leads to the tab (features/redirects).
 */

export const explorerRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: RESTORE_PATHS.explorer,
  validateSearch: (search: Record<string, unknown>) => parseExplorerSearch(search),
  component: RestoreRoutePage,
});

/** The explorer or, on `?tab=recent`, the recent restores. */
function RestoreRoutePage(): ReactElement {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  return restoreTabOf(search) === "recent"
    ? createElement(RestoreJobsPage)
    : createElement(ExplorerPage);
}

export const jobRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: RESTORE_PATHS.job,
  component: RestoreJobRoute,
});

function RestoreJobRoute(): ReactElement {
  const { restoreId } = jobRoute.useParams();
  return createElement(RestoreJobPage, { restoreId });
}

export const routes = [explorerRoute, jobRoute];

export const navItems: NavItem[] = [
  {
    id: "restore",
    path: RESTORE_PATHS.explorer,
    labelKey: "restore:nav.explorer",
    icon: MailSearch,
    group: "mail",
    // Covers the restores below it (`/restore/jobs/<id>`) too.
    order: 20,
  },
];
