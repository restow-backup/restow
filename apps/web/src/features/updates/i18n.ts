import updatesDe from "@restow/i18n/resources/de/updates.json" with { type: "json" };
import updatesEn from "@restow/i18n/resources/en/updates.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `updates` namespace ships with this feature. Registering it here keeps
 * the feature self-contained: the bundles are in place before the first
 * component renders, whether or not the shared package was rebuilt (identical
 * content merges harmlessly, deep merge, overwrite).
 */
export const UPDATES_NAMESPACE = "updates";

i18n.addResourceBundle("de", UPDATES_NAMESPACE, updatesDe, true, true);
i18n.addResourceBundle("en", UPDATES_NAMESPACE, updatesEn, true, true);
