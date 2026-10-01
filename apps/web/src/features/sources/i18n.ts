import sourcesDe from "@restow/i18n/resources/de/sources.json" with { type: "json" };
import sourcesEn from "@restow/i18n/resources/en/sources.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `sources` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace,
 * identical content merges harmlessly (deep merge, overwrite).
 */
export const SOURCES_NAMESPACE = "sources";

i18n.addResourceBundle("de", SOURCES_NAMESPACE, sourcesDe, true, true);
i18n.addResourceBundle("en", SOURCES_NAMESPACE, sourcesEn, true, true);
