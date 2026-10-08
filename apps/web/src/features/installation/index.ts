import { createRoute, redirect } from "@tanstack/react-router";
import { ServerCog } from "lucide-react";

import "@/features/installation/i18n";
import "@/features/settings/i18n";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import { INSTALLATION_ROLES, InstallationPage } from "./installation-page";
import { DEFAULT_SECTION_ID, INSTALLATION_PATH, installationSectionPath } from "./paths";
import { parseInstallationSearch } from "./presenters";
import { installationSections } from "./sections";

/**
 * Installation feature: the settings of the server and of the operation of all
 * tenants (or of the one organisation), at `/installation/<section>` with a
 * sub-navigation (Server, Notification mail, Microsoft multi-tenant app,
 * Default storage, Updates, About, and the sections extensions add). It is the
 * successor of the settings page; the old addresses redirect
 * (features/redirects). Team and the audit log are pages of their own in the
 * same menu section. The account page (`/account`) stays with the person.
 */

/** `/installation` leads to the first section. */
export const installationIndexRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: INSTALLATION_PATH,
  beforeLoad: () => {
    throw redirect({
      to: installationSectionPath(DEFAULT_SECTION_ID) as never,
      replace: true,
    });
  },
  // Never rendered: the guard always leaves.
  component: () => null,
});

export const installationSectionRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: `${INSTALLATION_PATH}/$section`,
  validateSearch: (search: Record<string, unknown>) => parseInstallationSearch(search),
  beforeLoad: ({ params }) => {
    // An address no section answers to (a section of an extension that is not part of this build).
    if (!installationSections().some((section) => section.id === params.section)) {
      throw redirect({
        to: installationSectionPath(DEFAULT_SECTION_ID) as never,
        replace: true,
      });
    }
  },
  component: InstallationPage,
});

export const routes = [installationIndexRoute, installationSectionRoute];

/**
 * "Server & operation" in the menu section Installation (not "Settings": the
 * organisation's own entry is the other settings page): it opens the page's first
 * section and stays highlighted on every section (except the ones that have an
 * entry of their own, such as the license an extension adds). Provider admins
 * only.
 */
export const navItems: NavItem[] = [
  {
    id: "settings",
    path: INSTALLATION_PATH,
    labelKey: "installation:nav",
    // Not the gear of the organisation's or tenant's settings: two entries, two meanings.
    icon: ServerCog,
    roles: [...INSTALLATION_ROLES],
    group: "installation",
    order: 10,
  },
];
