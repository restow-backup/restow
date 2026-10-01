import { i18n } from "@/i18n";

import licenseDe from "./i18n/de.json" with { type: "json" };
import licenseEn from "./i18n/en.json" with { type: "json" };

/**
 * The `license` namespace ships with this module (it is not part of the
 * core's @restow/i18n bundles): editions, the menu lock hints and the
 * license section of Settings, About.
 */
export const LICENSE_NAMESPACE = "license";

export const licenseResources = { de: licenseDe, en: licenseEn } as const;

i18n.addResourceBundle("de", LICENSE_NAMESPACE, licenseDe, true, true);
i18n.addResourceBundle("en", LICENSE_NAMESPACE, licenseEn, true, true);
