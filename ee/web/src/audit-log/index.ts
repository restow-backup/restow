import { createRoute } from "@tanstack/react-router";
import { ScrollText } from "lucide-react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { editionLock } from "../license/nav-lock";
import { AUDIT_ROLES, AuditPage } from "./audit-page";
import "./i18n";
import { AUDIT_PATH, parseAuditSearch } from "./search";

/**
 * The audit log viewer (Business and Service Provider, `audit.log`): the log
 * with filters, the hash-chain verification and the entry details. Provider
 * admins see the whole installation, tenant admins their own tenant; filters
 * and the open entry live in the URL. Recording happens in the core in every
 * edition; on Community the menu entry shows locked.
 */

export const auditRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: AUDIT_PATH,
  validateSearch: (search: Record<string, unknown>) => parseAuditSearch(search),
  component: AuditPage,
});

export const auditRoutes = [auditRoute];

export const auditNavItems: NavItem[] = [
  {
    id: "audit",
    path: AUDIT_PATH,
    labelKey: "audit:nav",
    icon: ScrollText,
    roles: [...AUDIT_ROLES],
    group: "admin",
    order: 20,
    lock: editionLock("business"),
  },
];
