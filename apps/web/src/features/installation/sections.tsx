import {
  AppWindow,
  CalendarClock,
  Coins,
  Container,
  Database,
  Download,
  HardDrive,
  Info,
  Layers,
  Mail,
  Server,
  ShieldAlert,
} from "lucide-react";

import { GlobalAgentPolicySection } from "@/features/endpoints/components/global-agent-policy-section";
import { PricingSection } from "@/features/pricing/pricing-section";
import { PveSettingsSection } from "@/features/pve/settings-section";
import { AboutSection } from "@/features/settings/sections/about-section";
import { RansomwareSection } from "@/features/suspicion/components/ransomware-section";
import { UpdatesSection } from "@/features/updates/updates-section";
import { extensionInstallationSections, type InstallationSectionSpec } from "@/lib/extensions";

import { DatabaseSection } from "./sections/database-section";
import { EditionSection } from "./sections/edition-section";
import { MicrosoftAppSection } from "./sections/microsoft-app-section";
import { RepositorySection } from "./sections/repository-section";
import { MailSectionPage, ServerSectionPage } from "./sections/settings-sections";

/**
 * The sections of the installation page (`/installation/<id>`), in the order of
 * its sub-navigation. The core's own sit at 10, 20, ...; the sections the
 * extensions add (Business: journal receiving, Service Provider: provider API,
 * the license) take the places between (lib/extensions.tsx
 * `InstallationSectionSpec`):
 *
 *   10 Server   20 Notification mail   30 Microsoft multi-tenant app
 *   40 Journal receiving (Business)    50 Default repository & network shares
 *   55 Database      57 Ransomware detection   58 Agent policy   59 Proxmox VE
 *   60 Provider API (Service Provider) 65 Prices 70 Updates
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
    // The default repository and the NFS shares (opt-in mounter, docs/MOUNTS.md) it and
    // the tenants' repositories can point at, on one page.
    id: "default-storage",
    labelKey: "installation:sections.repository",
    descriptionKey: "installation:descriptions.repository",
    icon: HardDrive,
    order: 50,
    component: RepositorySection,
  },
  {
    // Where the database keeps its data, the disks, moving it (docs/DATABASE.md).
    id: "database",
    labelKey: "installation:sections.database",
    descriptionKey: "installation:descriptions.database",
    icon: Database,
    order: 55,
    component: DatabaseSection,
  },
  {
    // The thresholds of the ransomware detection on backups (docs/RANSOMWARE.md).
    id: "ransomware",
    labelKey: "installation:sections.ransomware",
    descriptionKey: "installation:descriptions.ransomware",
    icon: ShieldAlert,
    order: 57,
    component: RansomwareSection,
  },
  {
    // The global policy for the agents of servers and clients, with its locks (docs/AGENT.md).
    id: "agent-policy",
    labelKey: "installation:sections.agentPolicy",
    descriptionKey: "installation:descriptions.agentPolicy",
    icon: CalendarClock,
    order: 58,
    component: GlobalAgentPolicySection,
  },
  {
    // Proxmox VE backups (docs/PVE.md, "Restore check"): checks right after every backup.
    id: "proxmox",
    labelKey: "installation:sections.proxmox",
    descriptionKey: "installation:descriptions.proxmox",
    icon: Container,
    order: 59,
    component: PveSettingsSection,
  },
  {
    // The provider's prices behind the price cards (0.4.7, per tenant 0.4.8): nothing bills them.
    id: "pricing",
    labelKey: "installation:sections.pricing",
    descriptionKey: "installation:descriptions.pricing",
    icon: Coins,
    order: 65,
    component: PricingSection,
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
