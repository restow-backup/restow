import pricingDe from "@restow/i18n/resources/de/pricing.json" with { type: "json" };
import pricingEn from "@restow/i18n/resources/en/pricing.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `pricing` namespace ships with this feature: the price cards, the editor of a tenant's
 * prices and the sum across the tenants. Every module that renders its text imports this file, so
 * the bundle is registered before the first card renders; identical content merges harmlessly
 * (deep merge, overwrite).
 */
export const PRICING_NAMESPACE = "pricing";

i18n.addResourceBundle("de", PRICING_NAMESPACE, pricingDe, true, true);
i18n.addResourceBundle("en", PRICING_NAMESPACE, pricingEn, true, true);
