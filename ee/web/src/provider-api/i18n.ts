import { i18n } from "@/i18n";

import providerApiDe from "./i18n/de.json" with { type: "json" };
import providerApiEn from "./i18n/en.json" with { type: "json" };

/**
 * The `providerApi` namespace ships with this module (not part of the core's @restow/i18n
 * bundles): the provider's own webhooks under Installation › Provider API (0.6.0).
 */
export const PROVIDER_API_NAMESPACE = "providerApi";

i18n.addResourceBundle("de", PROVIDER_API_NAMESPACE, providerApiDe, true, true);
i18n.addResourceBundle("en", PROVIDER_API_NAMESPACE, providerApiEn, true, true);
