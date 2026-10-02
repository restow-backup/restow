import type { NavItem } from "@/lib/navigation";

import "./i18n";

/**
 * Sources feature: Microsoft 365 tenants (admin consent, permission checklist)
 * and IMAP mailboxes (connection, test). Its pages are not routes of their own:
 * they are the Microsoft 365 and IMAP tabs of the Connections section of the
 * tenant page and the page of one source below it (features/tenant-page), which
 * also receives the parameters the admin-consent callback appends. The old
 * addresses `/sources...` lead there (features/redirects).
 */

export const routes = [];

/** No menu entry: the tenant settings entry opens the tenant page. */
export const navItems: NavItem[] = [];
