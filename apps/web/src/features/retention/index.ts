import type { NavItem } from "@/lib/navigation";

import "./i18n.js";

/**
 * Retention: how long backup restore points are kept, as a tenant default
 * plus per-object overrides on the tiered keep rule the worker's retention
 * handler enforces. Tenant-administrator only. The page is the "Backup
 * retention" section of the tenant page (features/tenant-page); the old
 * address `/retention` leads there (features/redirects).
 */

export const routes = [];

/** No menu entry: the tenant settings entry opens the tenant page. */
export const navItems: NavItem[] = [];
