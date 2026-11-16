import resourcesDe from "@restow/i18n/resources/de/resources.json" with { type: "json" };
import resourcesEn from "@restow/i18n/resources/en/resources.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `resources` namespace ships with this feature: the capacity page and its figures. Every
 * module that renders its text imports this file, so the bundle is registered before the page
 * renders; identical content merges harmlessly (deep merge, overwrite).
 */
export const RESOURCES_NAMESPACE = "resources";

i18n.addResourceBundle("de", RESOURCES_NAMESPACE, resourcesDe, true, true);
i18n.addResourceBundle("en", RESOURCES_NAMESPACE, resourcesEn, true, true);
