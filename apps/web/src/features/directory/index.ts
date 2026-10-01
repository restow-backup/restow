import { createRoute } from "@tanstack/react-router";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n";
import { DirectoryPage } from "./directory-page";
import { DIRECTORY_PATH, parseDirectorySearch } from "./search";

/**
 * Directory feature: the protected objects of the active tenant (mailboxes,
 * OneDrives, IMAP accounts), per-object decisions, the protection rules and
 * directory sync of Microsoft 365 sources, and the account list of IMAP
 * sources. The page keeps its filters in the URL.
 */

export const directoryRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: DIRECTORY_PATH,
  validateSearch: (search: Record<string, unknown>) => parseDirectorySearch(search),
  component: DirectoryPage,
});

export const routes = [directoryRoute];

/**
 * No menu entry of its own: the page is a tab of the tenant setup area
 * (features/tenant-setup), which the menu entry "Setup" or "Open tenant page"
 * opens.
 */
export const navItems: NavItem[] = [];
