import { KeyRound } from "lucide-react";

import { PROVIDER_API_SECTION_ID } from "@/features/integrations/paths";
import type { InstallationSectionSpec } from "@/lib/extensions";

import { editionLock } from "../license/nav-lock";
import { ProviderApiSection } from "./provider-api-section";

/**
 * Installation, Provider API: greyed out with a lock below Service Provider,
 * where it leads to the license section like a locked menu entry.
 */
export const providerApiInstallationSections: InstallationSectionSpec[] = [
  {
    id: PROVIDER_API_SECTION_ID,
    labelKey: "installation:sections.providerApi",
    descriptionKey: "installation:descriptions.providerApi",
    icon: KeyRound,
    order: 60,
    component: ProviderApiSection,
    lock: editionLock("service_provider"),
  },
];
