import type { WebExtension } from "@/lib/extensions";

import { ArchiveSections, ArchiveSettingsSections } from "./archive-sections";
import { auditNavItems, auditRoutes, auditTenantSections } from "./audit-log";
import { journalInstallationSections } from "./journal";
import { JobArchiveSetup } from "./journal/job-archive-setup";
import {
  licenseInstallationSections,
  licenseNavItems,
  licenseNavLocks,
  licenseSlots,
} from "./license";
import { providerApiInstallationSections } from "./provider-api";
import { ProviderView } from "./provider-dashboard/provider-view";
import { ReadinessByTenant } from "./provider-dashboard/readiness-by-tenant";

/**
 * Entry of the Business and Service Provider web modules (ee/README.md),
 * loaded by apps/web/src/features/ee.ts. Each feature contributes its pages,
 * menu entries, locks on core menu entries, sections of the installation page
 * and of the tenant page, and page sections (slots) here.
 */
export const eeWebExtension: WebExtension = {
  name: "ee",
  routes: auditRoutes,
  navItems: [...auditNavItems, ...licenseNavItems],
  navLocks: licenseNavLocks,
  tenantSections: auditTenantSections,
  installationSections: [
    ...journalInstallationSections,
    ...providerApiInstallationSections,
    ...licenseInstallationSections,
  ],
  slots: {
    "archive.sections": ArchiveSections,
    "tenant.archiveSettings": ArchiveSettingsSections,
    "jobs.archiveSetup": JobArchiveSetup,
    "dashboard.provider": ProviderView,
    "verify.byTenant": ReadinessByTenant,
    ...licenseSlots,
  },
};
