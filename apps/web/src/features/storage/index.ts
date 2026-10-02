import type { NavItem } from "@/lib/navigation";

import "./i18n";

/**
 * Repositories: where the tenant's chunk store lives (installation default,
 * primary and copy repositories), whether each one works and can enforce
 * WORM, and how much the tenant stores. The page is the Storage section of
 * the tenant page (features/tenant-page); it was "Storage" at `/storage` and
 * "Repositories" at `/repositories` before, and both addresses lead there
 * (features/redirects). The code and the API keep the name storage
 * (`/api/v1/storage`).
 */

export const routes = [];

/** No menu entry: the tenant settings entry opens the tenant page. */
export const navItems: NavItem[] = [];
