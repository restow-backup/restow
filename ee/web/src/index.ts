import type { WebExtension } from "@/lib/extensions";

import { ArchiveSections } from "./archive-sections";
import { auditNavItems, auditRoutes } from "./audit-log";
import { licenseNavItems, licenseNavLocks, licenseSlots } from "./license";
import { ProviderView } from "./provider-dashboard/provider-view";
import { teamNavItems, teamRoute } from "./provider-team";

/**
 * Entry of the Business and Service Provider web modules (ee/README.md),
 * loaded by apps/web/src/features/ee.ts. Each feature contributes its pages,
 * menu entries, locks on core menu entries and page sections (slots) here.
 */
export const eeWebExtension: WebExtension = {
  name: "ee",
  routes: [...auditRoutes, teamRoute],
  navItems: [...auditNavItems, ...licenseNavItems, ...teamNavItems],
  navLocks: licenseNavLocks,
  slots: {
    "archive.sections": ArchiveSections,
    "dashboard.provider": ProviderView,
    ...licenseSlots,
  },
};
