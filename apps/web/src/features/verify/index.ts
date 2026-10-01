import { createRoute } from "@tanstack/react-router";
import { createElement } from "react";

import "@/features/verify/i18n";
import { VERIFY_ICON, VERIFY_PATH } from "@/features/verify/paths";
import {
  VERIFY_ROLES,
  VerifyReportRoutePage,
  VerifyRoutePage,
} from "@/features/verify/route-pages";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

/**
 * Recovery readiness: the weekly restore proof per protected object
 * (green / yellow / red with date and findings, `unverified` while the newest
 * backup was not checked yet), the report behind every rating, and the
 * storage integrity check. Operator pages (tenant admins and provider
 * admins), see route-pages.tsx. The snapshot lists of the backup and restore
 * pages show each backup's own verification with SnapshotVerificationBadge.
 */

export const verifyRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: VERIFY_PATH,
  component: VerifyRoutePage,
});

export const verifyReportRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: `${VERIFY_PATH}/reports/$reportId`,
  component: function VerifyReportRoute() {
    const { reportId } = verifyReportRoute.useParams();
    return createElement(VerifyReportRoutePage, { reportId });
  },
});

export const routes = [verifyRoute, verifyReportRoute];

export const navItems: NavItem[] = [
  {
    id: "verify",
    path: VERIFY_PATH,
    labelKey: "verify:nav",
    icon: VERIFY_ICON,
    roles: [...VERIFY_ROLES],
    group: "daily",
    order: 20,
  },
];
