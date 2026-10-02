import type { NavItem } from "@/lib/navigation";

import "./i18n";

/**
 * Directory feature: the protected objects of the active tenant (mailboxes,
 * OneDrives, IMAP accounts), per-object decisions, the protection rules and
 * directory sync of Microsoft 365 sources, and the account list of IMAP
 * sources. The page is the Protection section of the tenant page
 * (features/tenant-page) and keeps its filters in the URL; the old address
 * `/protected-objects` leads there (features/redirects).
 */

export const routes = [];

/** No menu entry: the tenant settings entry opens the tenant page. */
export const navItems: NavItem[] = [];
