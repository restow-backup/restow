import { FileBadge } from "lucide-react";

import { SETTINGS_PATH } from "@/features/settings/paths";
import type { WebExtension } from "@/lib/extensions";
import type { NavItem } from "@/lib/navigation";

import { AboutLicense } from "./components/about-license";
import { EditionBadge } from "./components/edition-badge";
import { TenantsCreationLocked } from "./components/tenants-creation-locked";
import "./i18n";
import { editionLock } from "./nav-lock";

/**
 * The license module of ee/web: the edition read from the session
 * (`edition.ts`), menu locks by edition (`nav-lock.ts`) and what it adds to
 * core pages through slots: the license section of Settings, About, the
 * edition badge in the sidebar footer and the reason no further tenant can be
 * created. The core never names an edition itself.
 */

export { editionAllows, readEdition, requiredEditionOf, useEdition } from "./edition";
export type { Edition, LicensedEdition } from "./edition";
export { editionLock } from "./nav-lock";

/** Slots the license module fills (lib/extensions.tsx `SlotProps`). */
export const licenseSlots = {
  "settings.about": AboutLicense,
  "shell.sidebarFooter": EditionBadge,
  "tenants.creationLocked": TenantsCreationLocked,
} satisfies NonNullable<WebExtension["slots"]>;

/**
 * "License" in Admin: the license section of Settings, About, where the key
 * is installed (provider admins, like the section itself). The core's
 * Settings entry stays for every other section.
 */
export const licenseNavItems: NavItem[] = [
  {
    id: "license",
    path: SETTINGS_PATH,
    search: { section: "about" },
    labelKey: "license:nav",
    icon: FileBadge,
    roles: ["provider_admin"],
    group: "admin",
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
