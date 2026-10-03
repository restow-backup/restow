import { AppWindow, Download, HardDrive, Info, Layers, Mail, Network, Server } from "lucide-react";

import { AboutSection } from "@/features/settings/sections/about-section";
import { UpdatesSection } from "@/features/updates/updates-section";
import { type InstallationSectionSpec, extensionInstallationSections } from "@/lib/extensions";

import { DefaultStorageSection } from "./sections/default-storage-section";
import { EditionSection } from "./sections/edition-section";
import { MicrosoftAppSection } from "./sections/microsoft-app-section";
import { MountsSection } from "./sections/mounts-section";
import { MailSectionPage, ServerSectionPage } from "./sections/settings-sections";

/**
 * The sections of the installation page (`/installation/<id>`), in the order of
 * its sub-navigation. The core's own sit at 10, 20, ...; the sections the
 * extensions add (Business: journal receiving, Service Provider: provider API,
 * the license) take the places between (lib/extensions.tsx
 * `InstallationSectionSpec`):
 *
 *   10 Server   20 Notification mail   30 Microsoft multi-tenant app
 *   40 Journal receiving (Business)    50 Default storage    55 Mounts
 *   60 Provider API (Service Provider) 70 Updates
 *   80 License (extension) or Edition  90 About
 *
 * Edition (core) is the Community build's place for what the License section is in the
 * full build: it says which build runs and offers the switch to the full build. It is
 * shown only where no extension brings a License section, so the full build keeps its
 * License section as it is.
 *
 * Team and the audit log are pages of their own in the menu group Installation,
 * not sections: they are lists, this page is settings.
 */

export const CORE_INSTALLATION_SECTIONS: readonly InstallationSectionSpec[] = [
  {
    id: "server",
    labelKey: "installation:sections.server",
    descriptionKey: "installation:descriptions.server",
    icon: Server,
    order: 10,
    component: ServerSectionPage,
  },
  {
    id: "mail",
    labelKey: "installation:sections.mail",
    descriptionKey: "installation:descriptions.mail",
    icon: Mail,
    order: 20,
    component: MailSectionPage,
  },
  {
    id: "microsoft-app",
    labelKey: "installation:sections.microsoftApp",
    descriptionKey: "installation:descriptions.microsoftApp",
    icon: AppWindow,
    order: 30,
    component: MicrosoftAppSection,
  },
  {
    id: "default-storage",
    labelKey: "installation:sections.defaultStorage",
    descriptionKey: "installation:descriptions.defaultStorage",
    icon: HardDrive,
    order: 50,
    component: DefaultStorageSection,
  },
  {
    // NFS shares through the opt-in mounter (docs/MOUNTS.md), right after the default
    // storage they usually serve.
    id: "mounts",
    labelKey: "installation:sections.mounts",
    descriptionKey: "installation:descriptions.mounts",
    icon: Network,
    order: 55,
    component: MountsSection,
  },
  {
    id: "updates",
    labelKey: "installation:sections.updates",
    descriptionKey: "installation:descriptions.updates",
    icon: Download,
    order: 70,
    component: UpdatesSection,
  },
  {
    id: "about",
    labelKey: "installation:sections.about",
    descriptionKey: "installation:descriptions.about",
    icon: Info,
    order: 90,
    component: AboutSection,
  },
];

/** The Community build's section about the build and the switch to the full build. */
export const EDITION_SECTION: InstallationSectionSpec = {
  id: "edition",
  labelKey: "installation:sections.edition",
  descriptionKey: "installation:descriptions.edition",
  icon: Layers,
  order: 80,
  component: EditionSection,
};

/** The id of the section the full build's license module adds. */
export const LICENSE_SECTION_ID = "license";

/** The core's sections and the ones the extensions add, in sub-navigation order; a core id cannot be replaced. */
export function installationSections(): InstallationSectionSpec[] {
  const extensionSections = extensionInstallationSections();
  const fullBuild = extensionSections.some((spec) => spec.id === LICENSE_SECTION_ID);
  const core = fullBuild
    ? CORE_INSTALLATION_SECTIONS
    : [...CORE_INSTALLATION_SECTIONS, EDITION_SECTION];
  const taken = new Set(core.map((spec) => spec.id));
  const added = extensionSections.filter((spec) => {
    if (taken.has(spec.id)) {
      return false;
    }
    taken.add(spec.id);
    return true;
  });
  return [...core, ...added].sort((a, b) => a.order - b.order);
}
