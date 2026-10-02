import type { NavItem } from "@/lib/navigation";

import "./i18n";

/**
 * Mail file import: a wizard that brings EML, MSG, MBOX and ZIP files (also
 * MailStore exports as EML or MSG) into Restow as an imported mailbox, the
 * history of imports and one page per import with its live progress and report.
 * They are the Imports tab of the Connections section of the tenant page and
 * the pages below it (features/tenant-page); the wizard opens from there. The
 * old addresses `/sources/import` and `/imports...` lead there
 * (features/redirects).
 */

export const routes = [];

/** No menu entry: the tenant settings entry opens the tenant page. */
export const navItems: NavItem[] = [];
