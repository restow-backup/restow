import type { LucideIcon } from "lucide-react";

import type { GatedFeature } from "@/lib/api";

/**
 * Sidebar navigation model. Feature modules export `navItems` in this shape
 * (see `features/registry.ts`); the sidebar, the breadcrumbs and the command
 * palette group, filter by role, mark locked and upcoming entries, and render
 * them. Labels are i18n keys with namespace, e.g. `backup:nav.history`.
 */

/**
 * The sidebar's sections, in order. `tenants` is the tenant's own level (the
 * settings of the active tenant, the tenant-level pages that wait for their
 * place on the tenant page, and the list of all tenants); where the
 * installation has one organisation only it is labelled "Organisation"
 * ({@link navGroupLabelKey}). `installation` is the operator's level: the
 * server, the team, the audit log, the license. A "Pinned" section will open
 * the list once pins exist (0.2.0); it is shown only when it has entries, so
 * it needs no place here before then. `other` catches an extension's entry
 * without a section; the core places all of its own.
 */
export const NAV_GROUPS = [
  "daily",
  "mail",
  "endpoints",
  "tenants",
  "installation",
  "other",
] as const;

export type NavGroupId = (typeof NAV_GROUPS)[number];

/**
 * Id of the entry for the list of all tenants (tenant management). The
 * header names its level "All tenants" instead of a single tenant.
 */
export const ALL_TENANTS_NAV_ID = "tenants";

/**
 * What a {@link NavLock} (and {@link NavItem.visible}) decides on: the
 * signed-in session's enabled gated features and the fields server
 * extensions added to its profile, both null while the profile is still
 * loading (lib/session.tsx).
 */
export interface NavLockContext {
  features: readonly GatedFeature[] | null;
  extensions: Readonly<Record<string, unknown>> | null;
  /**
   * Whether a provider admin's team role covers every tenant (false for a
   * member limited to some); absent where it does not apply or is unknown.
   * Entries that look across every tenant hide while it is false.
   */
  providerAllTenants?: boolean;
}

/**
 * Extension point: a lock on a menu entry, supplied by a web extension (on
 * its own entries, or on a core entry by id through `WebExtension.navLocks`,
 * lib/extensions.tsx). The core knows nothing about why an entry is locked;
 * it asks the lock and renders a locked entry generically: greyed out, a lock
 * icon, `aria-disabled`, a link to `to` (with `search`) instead of the
 * feature, and the tooltip `label — t(hintKey)` (components/layout/app-sidebar.tsx).
 * The command palette leaves locked entries out.
 *
 * Maintainer decision, 2026-09-24: no vanishing menu items. While the profile
 * is loading (context fields null) a lock should report locked, so nothing
 * appears that might then vanish.
 */
export interface NavLock {
  isLocked(context: NavLockContext): boolean;
  /** Absolute app path a locked entry leads to. */
  to: string;
  /** Search params of that link, if any. */
  search?: Readonly<Record<string, string>>;
  /** i18n key (with namespace) of the reason shown next to the label. */
  hintKey: string;
}

export interface NavItem {
  /** Stable identifier, also used to infer the group when none is given. */
  id: string;
  /** Absolute route path under the app shell, e.g. `/history`. */
  path: string;
  /**
   * Search params the entry's link carries (`/jobs?type=mail`). The entry is
   * active only while the location carries them too, and it is more specific
   * than an entry on the same path without them (`/jobs?type=mail` is the mail
   * jobs, not the run list that shares the address).
   */
  search?: Readonly<Record<string, string>>;
  /** i18n key including namespace, e.g. `dashboard:nav`. */
  labelKey: string;
  icon: LucideIcon;
  /** Roles that may see the item; omitted or empty means everyone. */
  roles?: readonly string[];
  /** Section in the sidebar; inferred from `id` when omitted. */
  group?: NavGroupId;
  /** Match only the exact path for the active state (root-like items). */
  exact?: boolean;
  /**
   * Further paths that belong to the entry although they are not below its
   * own (pages without an entry of their own, e.g. the tabs of the tenant
   * setup area); each also covers the pages below it.
   */
  matches?: readonly string[];
  /** Ordering inside the group; lower first, default 100. */
  order?: number;
  /** Locks the entry while `lock.isLocked` says so (see {@link NavLock}). */
  lock?: NavLock;
  /**
   * Whether the installation offers the entry at all, decided on the same
   * context as a lock (e.g. a gated feature); hidden while it says false.
   * Two entries that stand for each other use it ("Settings" of the one
   * organisation, "Tenant settings" with tenant management), never to hide
   * what a lock should grey out.
   */
  visible?: (context: NavLockContext) => boolean;
  /**
   * A feature that does not exist yet but already has its place in the
   * menu: the release that brings it (`0.2.0`). The entry shows a "Soon"
   * badge and opens a short placeholder page instead of the feature.
   */
  soon?: string;
  /**
   * A feature still in development: the entry shows the stage ("Alpha") so
   * nobody mistakes it for something that already works.
   */
  stage?: "alpha";
}

/** A nav item as shown, with whether its lock holds it closed. */
export interface PlacedNavItem extends NavItem {
  /** True when the item has a lock and the lock reports locked. */
  locked: boolean;
}

export interface NavGroup {
  id: NavGroupId;
  items: PlacedNavItem[];
}

/** Role check the caller supplies (lib/session.tsx `canAccess`). */
export type RoleCheck = (role: string | null, allowed: readonly string[] | undefined) => boolean;

/** Search params of the current location, as the router parsed them. */
export type LocationSearch = Readonly<Record<string, unknown>>;

/**
 * Keywords that place an entry without an explicit section, first match wins.
 * The order matters: `tenant-settings` is a tenant entry although it also
 * says "setting".
 */
const GROUP_BY_KEYWORD: readonly [NavGroupId, readonly string[]][] = [
  ["daily", ["dashboard", "overview", "home", "history", "verify", "readiness", "alert", "stats"]],
  ["endpoints", ["endpoint", "inventory", "machine", "agent", "file-restore"]],
  [
    "mail",
    ["mail", "restore", "archive", "journal", "hold", "export", "onedrive", "mailbox", "imap"],
  ],
  ["tenants", ["tenant", "organisation", "setup", "member", "repositor", "integration"]],
  [
    "installation",
    ["setting", "user", "team", "audit", "storage", "notification", "api", "license", "resource"],
  ],
];

/**
 * i18n key (namespace common) of a section's label. The tenants section reads
 * "Organisation" where the installation does not manage tenants (feature
 * `tenants.additional` off): there is the one organisation and the word
 * "tenant" has no place in the menu.
 */
export function navGroupLabelKey(
  group: NavGroupId,
  context: Pick<NavLockContext, "features">,
): string {
  if (group === "tenants" && !(context.features ?? []).includes("tenants.additional")) {
    return "nav.groups.organisation";
  }
  return `nav.groups.${group}`;
}

/** Infer the sidebar section from an item id such as `mail-exports`. */
export function inferNavGroup(id: string): NavGroupId {
  const haystack = id.toLowerCase();
  for (const [group, keywords] of GROUP_BY_KEYWORD) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return group;
    }
  }
  return "other";
}

/** The section an item is shown in. */
export function navGroupOf(item: Pick<NavItem, "id" | "group">): NavGroupId {
  return item.group ?? inferNavGroup(item.id);
}

/** Whether an item's lock holds it closed in `context` (an item without a lock never is). */
export function isNavItemLocked(item: Pick<NavItem, "lock">, context: NavLockContext): boolean {
  return item.lock ? item.lock.isLocked(context) : false;
}

/** Whether the installation offers the item at all (see {@link NavItem.visible}). */
export function isNavItemOffered(item: Pick<NavItem, "visible">, context: NavLockContext): boolean {
  return item.visible ? item.visible(context) : true;
}

/** The items the role may see and the installation offers, in their original order, each marked locked or not. */
export function visibleNavItems(
  items: readonly NavItem[],
  role: string | null,
  canAccess: RoleCheck,
  context: NavLockContext,
): PlacedNavItem[] {
  return items
    .filter((item) => canAccess(role, item.roles) && isNavItemOffered(item, context))
    .map((item) => ({ ...item, locked: isNavItemLocked(item, context) }));
}

/**
 * Split items into ordered, non-empty groups, dropping only those the role
 * may not see or the installation does not offer; a locked item still gets
 * a (locked) entry, see {@link NavLock}. Group order follows
 * {@link NAV_GROUPS}; item order follows `order`, then insertion order.
 */
export function groupNavItems(
  items: readonly NavItem[],
  role: string | null,
  canAccess: RoleCheck,
  context: NavLockContext,
): NavGroup[] {
  const buckets = new Map<NavGroupId, PlacedNavItem[]>();

  items.forEach((item, index) => {
    if (!canAccess(role, item.roles) || !isNavItemOffered(item, context)) {
      return;
    }
    const group = navGroupOf(item);
    const bucket = buckets.get(group) ?? [];
    bucket.push({
      ...item,
      order: item.order ?? 100 + index,
      locked: isNavItemLocked(item, context),
    });
    buckets.set(group, bucket);
  });

  return NAV_GROUPS.flatMap((id) => {
    const bucket = buckets.get(id);
    if (!bucket || bucket.length === 0) {
      return [];
    }
    bucket.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return [{ id, items: bucket }];
  });
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function isInside(base: string, pathname: string): boolean {
  return pathname === base || (base !== "/" && pathname.startsWith(`${base}/`));
}

/** Whether the location carries every search param the item's link sets. */
function searchMatches(item: Pick<NavItem, "search">, search: LocationSearch | undefined): boolean {
  if (!item.search) {
    return true;
  }
  return Object.entries(item.search).every(
    ([key, value]) => search !== undefined && search[key] != null && String(search[key]) === value,
  );
}

/**
 * The path of the item that `pathname` falls under: its own path or one of
 * its `matches`, the longest that applies; null when none does (or the
 * location lacks the item's search params).
 */
export function matchedNavPath(
  item: Pick<NavItem, "path" | "exact" | "matches" | "search">,
  pathname: string,
  search?: LocationSearch,
): string | null {
  if (!searchMatches(item, search)) {
    return null;
  }
  const normalizedPath = normalizePath(pathname);
  const itemPath = normalizePath(item.path);
  let best: string | null = null;
  if (item.exact || itemPath === "/") {
    best = normalizedPath === itemPath ? itemPath : null;
  } else if (isInside(itemPath, normalizedPath)) {
    best = itemPath;
  }
  for (const extra of item.matches ?? []) {
    const base = normalizePath(extra);
    if (isInside(base, normalizedPath) && (best === null || base.length > best.length)) {
      best = base;
    }
  }
  return best;
}

/** Whether `pathname` (with `search`) is inside the item (exact only for root-like items). */
export function isNavItemActive(
  item: Pick<NavItem, "path" | "exact" | "matches" | "search">,
  pathname: string,
  search?: LocationSearch,
): boolean {
  return matchedNavPath(item, pathname, search) !== null;
}

/**
 * The one item a location belongs to: the most specific match, so
 * `/restore/jobs/42` lights up an entry on `/restore/jobs` rather than one
 * on `/restore`, and `/jobs?type=mail` the entry whose search says so.
 */
export function findActiveNavItem<T extends Pick<NavItem, "path" | "exact" | "matches" | "search">>(
  items: readonly T[],
  pathname: string,
  search?: LocationSearch,
): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const item of items) {
    const matched = matchedNavPath(item, pathname, search);
    if (matched === null) {
      continue;
    }
    // Path length first; among entries on the same path the one that also
    // matches more search params wins.
    const score = matched.length * 100 + Object.keys(item.search ?? {}).length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/** Whether `pathname` is the item's own page rather than a page below it. */
export function isNavItemPage(item: Pick<NavItem, "path">, pathname: string): boolean {
  return normalizePath(item.path) === normalizePath(pathname);
}

/**
 * Where to go after switching the tenant. A list page stays (it now shows the
 * other tenant's entries); a detail page belongs to the previous tenant, so
 * it gives way to its list. `null` means stay.
 */
export function pathAfterTenantSwitch(
  pathname: string,
  items: readonly Pick<NavItem, "path" | "exact" | "matches" | "search">[],
): string | null {
  const item = findActiveNavItem(items, pathname);
  if (!item) {
    return null;
  }
  const list = matchedNavPath(item, pathname);
  if (list === null || list === normalizePath(pathname)) {
    return null;
  }
  return list;
}
