import { useRouterState } from "@tanstack/react-router";
import { Fingerprint } from "lucide-react";
import * as React from "react";

import {
  TENANT_SETUP_NAV_ID,
  type TenantSetupTab,
  findTenantSetupTab,
} from "@/features/tenant-setup/tabs";
import { ACCOUNT_PATH } from "@/lib/entry";
import {
  type LocationSearch,
  type NavGroupId,
  type NavItem,
  type NavLockContext,
  findActiveNavItem,
  isNavItemOffered,
  navGroupOf,
} from "@/lib/navigation";
import { useSession } from "@/lib/session";
import { useNavItems } from "@/lib/use-nav-items";

/**
 * Which navigation entry the current page belongs to: the sidebar highlights
 * it, the breadcrumbs start from it and the page header borrows its icon.
 */

/**
 * Pages of the shell that have no sidebar entry but still deserve an icon and
 * a breadcrumb; account security is reached from the user menu.
 */
export const SHELL_PAGES: readonly NavItem[] = [
  { id: "account", path: ACCOUNT_PATH, labelKey: "user.security", icon: Fingerprint },
];

/** Id of the entry that stands for the tenant setup area where tenants are managed. */
const ALL_TENANTS_NAV_ID = "tenants";

export interface ShellEntry {
  item: NavItem;
  /** Sidebar group of the entry; null for shell pages outside the menu. */
  group: NavGroupId | null;
  /** The tab of the tenant setup area the page belongs to, if it is part of it. */
  setupTab?: TenantSetupTab;
}

/**
 * The entry for a location: the most specific menu item, else a shell page.
 * Pages of the tenant setup area belong to "Setup" where the installation
 * offers it (one tenant), else to "All tenants".
 */
export function resolveShellEntry(
  navItems: readonly NavItem[],
  pathname: string,
  search?: LocationSearch,
  context?: NavLockContext,
): ShellEntry | null {
  const setupTab = findTenantSetupTab(pathname);
  if (setupTab) {
    const setup = navItems.find((item) => item.id === TENANT_SETUP_NAV_ID);
    const offered = setup && (!context || isNavItemOffered(setup, context)) ? setup : null;
    const item = offered ?? navItems.find((candidate) => candidate.id === ALL_TENANTS_NAV_ID);
    if (item) {
      return { item, group: navGroupOf(item), setupTab };
    }
  }
  const item = findActiveNavItem(navItems, pathname, search);
  if (item) {
    return { item, group: navGroupOf(item) };
  }
  const page = findActiveNavItem(SHELL_PAGES, pathname);
  return page ? { item: page, group: null } : null;
}

/** The shell entry of the current location. */
export function useShellEntry(): ShellEntry | null {
  const navItems = useNavItems();
  const { features, extensions } = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({
    select: (state) => state.location.search as LocationSearch,
  });
  return React.useMemo(
    () => resolveShellEntry(navItems, pathname, search, { features, extensions }),
    [navItems, pathname, search, features, extensions],
  );
}
