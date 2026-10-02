import { Inbox } from "lucide-react";

import type { InstallationSectionSpec } from "@/lib/extensions";

import { editionLock } from "../license/nav-lock";
import { JournalReceivingSection } from "./receiving-section";

/**
 * Installation, Journal receiving: the receiver of Exchange journal reports,
 * for every tenant. Greyed out with a lock below Business, where it leads to
 * the license section like a locked menu entry. (The tenant's own journal
 * address and guide sit on its Archive page: ../archive-sections.tsx.)
 */
export const journalInstallationSections: InstallationSectionSpec[] = [
  {
    id: "journal",
    labelKey: "installation:sections.journal",
    descriptionKey: "installation:descriptions.journal",
    icon: Inbox,
    order: 40,
    component: JournalReceivingSection,
    lock: editionLock("business"),
  },
];
