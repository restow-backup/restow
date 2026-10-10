import { useRouterState } from "@tanstack/react-router";
import { Fingerprint } from "lucide-react";
import * as React from "react";

import { ACCOUNT_PATH } from "@/lib/entry";
import {
  ALL_TENANTS_NAV_ID,
  type LocationSearch,
  type NavGroupId,
  type NavItem,
  type NavLockContext,
  findActiveNavItem,
  isNavItemOffered,
  navGroupOf,
} from "@/lib/navigation";
import { canAccess, useSession } from "@/lib/session";
import { TENANT_SETTINGS_NAV_IDS } from "@/lib/tenant-nav";
import { TENANTS_PATH, parseTenantPagePath } from "@/lib/tenant-paths";
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

export interface ShellEntry {
  item: NavItem;
  /** Sidebar group of the entry; null for shell pages outside the menu. */
  group: NavGroupId | null;
}

/**
 * The entry for a location: the most specific menu item, else a shell page.
 * The pages of a tenant's page (`/tenants/<id>/...`) belong to the settings
 * entry ("Tenant settings", or "Settings" of the one organisation; its `matches`
 * cover the active tenant's pages, lib/tenant-nav.ts), not to "Manage tenants"
 * below `/tenants`: the more specific address wins. That holds for the address of
 * a tenant that is not the active one as well (the page of a tenant that is not
 * yours, a tenant's page in the moment before it becomes the active one), so that
 * such a page never reads as the list of all tenants.
 *
 * An entry that opens one section of the active tenant's page ("Repositories")
 * wins on that section, so the menu highlights it there and not the settings.
 *
 * Given the `role`, an entry the role is offered wins over one it is not, so
 * the page belongs to the section the person sees it in; a page the role has
 * no entry for (it is denied there) still resolves to the most specific entry.
 */
export function resolveShellEntry(
  navItems: readonly NavItem[],
  pathname: string,
  search?: LocationSearch,
  context?: NavLockContext,
  role?: string | null,
): ShellEntry | null {
  // Entries that stand for each other (the tenant settings in two wordings) exist once.
  const present = context
    ? navItems.filter((candidate) => isNavItemOffered(candidate, context))
    : navItems;
  const offered =
    role === undefined ? present : present.filter((candidate) => canAccess(role, candidate.roles));
  // The list of tenants is "Manage tenants", also while "All tenants" has the tenant settings entry
  // lead there (lib/use-nav-items.ts): two entries on one address, the list is the one that is meant.
  if (pathname.replace(/\/+$/, "") === TENANTS_PATH) {
    const list =
      offered.find((candidate) => candidate.id === ALL_TENANTS_NAV_ID) ??
      present.find((candidate) => candidate.id === ALL_TENANTS_NAV_ID);
    if (list) {
      return { item: list, group: navGroupOf(list) };
    }
  }
  if (parseTenantPagePath(pathname)) {
    // An entry that opens one section of the active tenant's page ("Repositories",
    // lib/tenant-nav.ts) is the more specific one on that section.
    const sectionEntries = offered.filter(
      (candidate) =>
        !TENANT_SETTINGS_NAV_IDS.includes(candidate.id) &&
        candidate.path.startsWith(`${TENANTS_PATH}/`),
    );
    const section = findActiveNavItem(sectionEntries, pathname, search);
    if (section) {
      return { item: section, group: navGroupOf(section) };
    }
    const settings =
      offered.find((candidate) => TENANT_SETTINGS_NAV_IDS.includes(candidate.id)) ??
      present.find((candidate) => TENANT_SETTINGS_NAV_IDS.includes(candidate.id));
    if (settings) {
      return { item: settings, group: navGroupOf(settings) };
    }
  }
  const item =
    findActiveNavItem(offered, pathname, search) ?? findActiveNavItem(present, pathname, search);
  if (item) {
    return { item, group: navGroupOf(item) };
  }
  const page = findActiveNavItem(SHELL_PAGES, pathname);
  return page ? { item: page, group: null } : null;
}

/** The shell entry of the current location. */
export function useShellEntry(): ShellEntry | null {
  const navItems = useNavItems();
  const { features, extensions, role } = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({
    select: (state) => state.location.search as LocationSearch,
  });
  return React.useMemo(
    () => resolveShellEntry(navItems, pathname, search, { features, extensions }, role),
    [navItems, pathname, search, features, extensions, role],
  );
}
