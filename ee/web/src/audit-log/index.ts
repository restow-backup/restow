import { createRoute } from "@tanstack/react-router";
import { ScrollText } from "lucide-react";

import type { TenantSectionSpec } from "@/lib/extensions";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { editionLock } from "../license/nav-lock";
import { AuditPage, TenantAuditSection } from "./audit-page";
import "./i18n";
import { AUDIT_PATH, parseAuditSearch } from "./search";

/**
 * The audit log viewer (Business and Service Provider, `audit.log`): the log
 * with filters, the hash-chain verification and the entry details. Provider
 * admins see the whole installation, tenant admins their own tenant (on their
 * tenant's page); filters and the open entry live in the URL. Recording happens in the core in every
 * edition; on Community the menu entry shows locked.
 */

export const auditRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: AUDIT_PATH,
  validateSearch: (search: Record<string, unknown>) => parseAuditSearch(search),
  component: AuditPage,
});

export const auditRoutes = [auditRoute];

/**
 * The menu entry is the provider admins': Installation, Audit log, where the log
 * covers every tenant and filters by tenant. A tenant's own administrator's log
 * is their tenant's alone (the API narrows it), so it is the section "Audit log"
 * of their tenant's page, which the tenant page lists for them (and for the
 * provider admin who opens that tenant's page). Their old address `/audit`
 * leads there.
 */
export const auditNavItems: NavItem[] = [
  {
    id: "audit",
    path: AUDIT_PATH,
    labelKey: "audit:nav",
    icon: ScrollText,
    roles: ["provider_admin"],
    group: "installation",
    order: 30,
    lock: editionLock("business"),
  },
];

/** The audit log as a section of the tenant page, between Members and Master data. */
export const auditTenantSections: TenantSectionSpec[] = [
  {
    id: "audit",
    labelKey: "audit:nav",
    descriptionKey: "audit:sectionDescription",
    icon: ScrollText,
    order: 120,
    component: TenantAuditSection,
    lock: editionLock("business"),
  },
];
