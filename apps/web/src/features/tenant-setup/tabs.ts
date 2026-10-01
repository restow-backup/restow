import { CalendarClock, FileInput, Hourglass, type LucideIcon, Plug, Shield } from "lucide-react";

import { DIRECTORY_PATH } from "@/features/directory/search";
import { IMPORT_PATHS } from "@/features/imports/paths";
import { BACKUP_PATH } from "@/features/jobs/paths";
import { RETENTION_PATH } from "@/features/retention/paths";
import { SCHEDULES_PATH } from "@/features/schedules/paths";
import { SOURCES_PATH } from "@/features/sources/paths";

/**
 * The tenant setup area: the pages that set up how one tenant is protected
 * (protection, sources, schedules, retention, imports), shown with one shared
 * tab bar instead of a menu entry each. Each tab is the existing page at its
 * existing address, so old links and bookmarks keep working. Community and
 * Business reach the area through the menu entry "Setup", a service provider
 * through "Open tenant page" (tenant switcher, All tenants). The area always
 * shows the active tenant; opening it for another tenant switches first.
 *
 * Release 0.2.0 turns this into the tenant page `/tenants/$id/$tab` with the
 * tabs Overview, Protection, Jobs, Retention, Imports, Agents, Modules and
 * Settings (plan step 5).
 */

const ADMIN_ROLES = ["provider_admin", "tenant_admin"] as const;

export interface TenantSetupTab {
  id: "protection" | "sources" | "schedules" | "retention" | "imports";
  /** The tab's page. */
  path: string;
  /** Further pages that belong to the tab (below them too), e.g. the import wizard. */
  also?: readonly string[];
  /** i18n key with namespace. */
  labelKey: string;
  icon: LucideIcon;
  /** Roles that may open the tab; omitted means everyone. */
  roles?: readonly string[];
}

export const TENANT_SETUP_TABS: readonly TenantSetupTab[] = [
  {
    id: "protection",
    path: DIRECTORY_PATH,
    // The per-object backup page belongs to protection ("Back up now").
    also: [BACKUP_PATH],
    labelKey: "nav.setup.tabs.protection",
    icon: Shield,
    roles: ADMIN_ROLES,
  },
  {
    id: "sources",
    path: SOURCES_PATH,
    labelKey: "nav.setup.tabs.sources",
    icon: Plug,
    roles: ADMIN_ROLES,
  },
  {
    id: "schedules",
    path: SCHEDULES_PATH,
    labelKey: "nav.setup.tabs.schedules",
    icon: CalendarClock,
  },
  {
    id: "retention",
    path: RETENTION_PATH,
    labelKey: "nav.setup.tabs.retention",
    icon: Hourglass,
    roles: ADMIN_ROLES,
  },
  {
    id: "imports",
    path: IMPORT_PATHS.list,
    // The import wizard lives below /sources but is part of importing.
    also: [IMPORT_PATHS.wizard],
    labelKey: "nav.setup.tabs.imports",
    icon: FileInput,
    roles: ADMIN_ROLES,
  },
];

/** The area's first tab: where "Setup" and "Open tenant page" lead. */
export const TENANT_SETUP_PATH = DIRECTORY_PATH;

/** Every page of the area (with the pages below them), for the menu entry's `matches`. */
export const TENANT_SETUP_PATHS: readonly string[] = TENANT_SETUP_TABS.flatMap((tab) => [
  tab.path,
  ...(tab.also ?? []),
]);

/** Id of the menu entry of the area in one-tenant installations. */
export const TENANT_SETUP_NAV_ID = "tenant-setup";

function normalize(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function inside(base: string, pathname: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** The tab `pathname` belongs to (the most specific page that covers it), or null. */
export function findTenantSetupTab(pathname: string): TenantSetupTab | null {
  const path = normalize(pathname);
  let best: TenantSetupTab | null = null;
  let bestLength = -1;
  for (const tab of TENANT_SETUP_TABS) {
    for (const base of [tab.path, ...(tab.also ?? [])]) {
      if (inside(base, path) && base.length > bestLength) {
        best = tab;
        bestLength = base.length;
      }
    }
  }
  return best;
}

/** Whether `pathname` is a tab's own page (the tab bar shows there), not a page below it. */
export function isTenantSetupTabPage(pathname: string): boolean {
  const path = normalize(pathname);
  return TENANT_SETUP_TABS.some((tab) => tab.path === path);
}

/** The tabs the role may open, in order. */
export function visibleTenantSetupTabs(
  role: string | null,
  canAccess: (role: string | null, allowed: readonly string[] | undefined) => boolean,
): TenantSetupTab[] {
  return TENANT_SETUP_TABS.filter((tab) => canAccess(role, tab.roles));
}
