import { createRoute } from "@tanstack/react-router";
import { Archive as ArchiveIcon } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n.js";
import { ArchivePage } from "./archive-page.js";
import { ARCHIVE_PATH } from "./paths.js";

/**
 * Archive: full text search and hash chain verification (docs/ARCHIVE.md).
 * Legal holds are a section of the Business/Service Provider modules
 * (ee/web), rendered through the page's `archive.sections` slot.
 * Tenant-administrator only (see hooks.ts's useTenantScope and
 * apps/api/src/features/archive/routes.ts). The menu entry shows only where the
 * tenant offers the archive (lib/tenant-nav-offers.ts); the page stays
 * reachable by its address.
 */

export const archiveRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: ARCHIVE_PATH,
  component: ArchivePage,
});

export const routes = [archiveRoute];

export const navItems: NavItem[] = [
  {
    id: "archive",
    path: ARCHIVE_PATH,
    labelKey: "archive:nav",
    icon: ArchiveIcon,
    roles: ["provider_admin", "tenant_admin"],
    // Only where the tenant has an archive: it holds mail, or the edition captures and a
    // capture is set up (docs/ARCHIVE.md, "Eintrag „Archiv“ im Menü").
    tenantOffer: "archive",
    group: "mail",
    order: 30,
  },
];
