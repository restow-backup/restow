import { HardDrive } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { REPOSITORIES_NAV_ID, REPOSITORIES_PATH } from "@/lib/tenant-nav";

import "./i18n";

/**
 * Repositories: where the tenant's chunk store lives (installation default,
 * primary and copy repositories), whether each one works and can enforce
 * WORM, and how much the tenant stores. The page is the section `storage`
 * of the tenant page (features/tenant-page), labelled "Repositories"; it was
 * "Storage" at `/storage` and "Repositories" at `/repositories` before, and
 * both addresses lead there (features/redirects). The code and the API keep
 * the name storage (`/api/v1/storage`).
 */

export const routes = [];

/**
 * "Repositories" in the menu section of the tenant (Organisation where the
 * installation has one), right below the settings entry: it opens the section
 * of the active tenant's page directly (maintainer decision 2026-10-10). The
 * same roles as the tenant page itself: provider admins and the tenant's own
 * administrators (features/tenant-page `TENANT_PAGE_ROLES`).
 */
export const navItems: NavItem[] = [
  {
    id: REPOSITORIES_NAV_ID,
    path: REPOSITORIES_PATH,
    labelKey: "storage:nav",
    icon: HardDrive,
    roles: ["provider_admin", "tenant_admin"],
    group: "tenants",
    order: 20,
  },
];
