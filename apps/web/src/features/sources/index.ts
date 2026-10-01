import { createRoute } from "@tanstack/react-router";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";
import "./i18n";
import { parseConsentSearch } from "./presenters";
import { SourceDetailPage } from "./source-detail-page";
import { SourcesPage } from "./sources-page";

/**
 * Sources feature: Microsoft 365 tenants (admin consent, permission
 * checklist) and IMAP mailboxes (connection, test). Both routes accept the
 * parameters the admin-consent callback appends; unknown values are dropped.
 */

export const sourcesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/sources",
  validateSearch: (search: Record<string, unknown>) => parseConsentSearch(search),
  component: SourcesPage,
});

export const sourceDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/sources/$sourceId",
  validateSearch: (search: Record<string, unknown>) => parseConsentSearch(search),
  component: SourceDetailPage,
});

export const routes = [sourcesRoute, sourceDetailRoute];

/**
 * No menu entry of its own: the page is a tab of the tenant setup area
 * (features/tenant-setup), which the menu entry "Setup" or "Open tenant page"
 * opens.
 */
export const navItems: NavItem[] = [];
