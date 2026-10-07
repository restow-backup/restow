import { FileBadge } from "lucide-react";

import { installationSectionPath } from "@/features/installation/paths";
import type { InstallationSectionSpec, WebExtension } from "@/lib/extensions";
import type { NavItem } from "@/lib/navigation";

import { AboutLicense } from "./components/about-license";
import { EditionBadge } from "./components/edition-badge";
import { ReportsScheduleLocked } from "./components/reports-schedule-locked";
import { TeamScopeLocked } from "./components/team-scope-locked";
import { TenantsCreationLocked } from "./components/tenants-creation-locked";
import "./i18n";
import { LICENSE_SECTION_ID, editionLock } from "./nav-lock";

/**
 * The license module of ee/web: the edition read from the session
 * (`edition.ts`), locks by edition (`nav-lock.ts`) and what it adds to core
 * pages: the license section of the installation page, the edition badge in
 * the sidebar footer, the reason no further tenant can be created and the
 * reason a member cannot be limited to chosen tenants. The core
 * never names an edition itself.
 */

export { editionAllows, readEdition, requiredEditionOf, useEdition } from "./edition";
export type { Edition, LicensedEdition } from "./edition";
export { LICENSE_SECTION_ID, editionLock } from "./nav-lock";

/** Slots the license module fills (lib/extensions.tsx `SlotProps`). */
export const licenseSlots = {
  "shell.sidebarFooter": EditionBadge,
  "tenants.creationLocked": TenantsCreationLocked,
  "team.tenantScopeLocked": TeamScopeLocked,
  "reports.scheduleLocked": ReportsScheduleLocked,
} satisfies NonNullable<WebExtension["slots"]>;

/**
 * Installation, License: a section of its own, where the key is installed
 * (provider admins, like the page itself). It used to be a card on the About
 * page, so the old address of About (`/settings?section=about`) leads here.
 * Every edition can open it: it is where a locked section sends you.
 */
export const licenseInstallationSections: InstallationSectionSpec[] = [
  {
    id: LICENSE_SECTION_ID,
    labelKey: "license:nav",
    descriptionKey: "license:about.description",
    icon: FileBadge,
    order: 80,
    component: AboutLicense,
    legacySettingsSection: "about",
  },
];

/**
 * "License" in Installation: the menu entry that opens the license section,
 * where the key is installed (provider admins, like the section itself).
 */
export const licenseNavItems: NavItem[] = [
  {
    id: "license",
    path: installationSectionPath(LICENSE_SECTION_ID),
    labelKey: "license:nav",
    icon: FileBadge,
    roles: ["provider_admin"],
    group: "installation",
    order: 40,
  },
];

/** Locks on core menu entries, by nav item id (lib/extensions.tsx `navLocks`). */
export const licenseNavLocks = {
  // Managing tenants is Service Provider: below it the entry shows locked and
  // leads to the license section (the page itself stays reachable, for the
  // first tenant of a fresh installation).
  tenants: editionLock("service_provider"),
} satisfies NonNullable<WebExtension["navLocks"]>;
