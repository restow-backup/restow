import { i18n } from "@/i18n";

import billingDe from "./i18n/de.json" with { type: "json" };
import billingEn from "./i18n/en.json" with { type: "json" };

/**
 * The `billing` namespace ships with this module (it is not part of the core's @restow/i18n
 * bundles): Installation › Billing, the closed months of the billing close.
 */
export const BILLING_NAMESPACE = "billing";

export const billingResources = { de: billingDe, en: billingEn } as const;

i18n.addResourceBundle("de", BILLING_NAMESPACE, billingDe, true, true);
i18n.addResourceBundle("en", BILLING_NAMESPACE, billingEn, true, true);
