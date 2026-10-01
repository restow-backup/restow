import statsDe from "@restow/i18n/resources/de/stats.json" with { type: "json" };
import statsEn from "@restow/i18n/resources/en/stats.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `stats` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace,
 * identical content merges harmlessly (deep merge, overwrite).
 */
export const STATS_NAMESPACE = "stats";

i18n.addResourceBundle("de", STATS_NAMESPACE, statsDe, true, true);
i18n.addResourceBundle("en", STATS_NAMESPACE, statsEn, true, true);
