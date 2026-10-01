import settingsDe from "@restow/i18n/resources/de/settings.json" with { type: "json" };
import settingsEn from "@restow/i18n/resources/en/settings.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `settings` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace,
 * identical content merges harmlessly (deep merge, overwrite).
 */
export const SETTINGS_NAMESPACE = "settings";

i18n.addResourceBundle("de", SETTINGS_NAMESPACE, settingsDe, true, true);
i18n.addResourceBundle("en", SETTINGS_NAMESPACE, settingsEn, true, true);
