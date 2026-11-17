import { Receipt } from "lucide-react";

import type { InstallationSectionSpec } from "@/lib/extensions";

import { editionLock } from "../license/nav-lock";
import { BillingSection } from "./billing-section";
import "./i18n";

/** The section of Installation that holds the monthly billing close. */
export const BILLING_SECTION_ID = "billing";

/**
 * Installation, Billing (0.6.0): greyed out with a lock below Service Provider, where it leads to
 * the license section like a locked menu entry.
 */
export const billingInstallationSections: InstallationSectionSpec[] = [
  {
    id: BILLING_SECTION_ID,
    labelKey: "billing:section.label",
    descriptionKey: "billing:section.description",
    icon: Receipt,
    order: 61,
    component: BillingSection,
    lock: editionLock("service_provider"),
  },
];
