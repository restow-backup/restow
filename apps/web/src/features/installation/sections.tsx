import { AppWindow, Download, HardDrive, Info, Mail, Server } from "lucide-react";

import { AboutSection } from "@/features/settings/sections/about-section";
import { UpdatesSection } from "@/features/updates/updates-section";
import { type InstallationSectionSpec, extensionInstallationSections } from "@/lib/extensions";

import { DefaultStorageSection } from "./sections/default-storage-section";
import { MicrosoftAppSection } from "./sections/microsoft-app-section";
import { MailSectionPage, ServerSectionPage } from "./sections/settings-sections";

/**
 * The sections of the installation page (`/installation/<id>`), in the order of
 * its sub-navigation. The core's own sit at 10, 20, ...; the sections the
 * extensions add (Business: journal receiving, Service Provider: provider API,
 * the license) take the places between (lib/extensions.tsx
 * `InstallationSectionSpec`):
 *
 *   10 Server   20 Notification mail   30 Microsoft multi-tenant app
 *   40 Journal receiving (Business)    50 Default storage
 *   60 Provider API (Service Provider) 70 Updates
 *   80 License (extension)             90 About
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

/** The core's sections and the ones the extensions add, in sub-navigation order; a core id cannot be replaced. */
export function installationSections(): InstallationSectionSpec[] {
  const taken = new Set(CORE_INSTALLATION_SECTIONS.map((spec) => spec.id));
  const added = extensionInstallationSections().filter((spec) => {
    if (taken.has(spec.id)) {
      return false;
    }
    taken.add(spec.id);
    return true;
  });
  return [...CORE_INSTALLATION_SECTIONS, ...added].sort((a, b) => a.order - b.order);
}
