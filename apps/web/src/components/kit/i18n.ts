import uiDe from "@restow/i18n/resources/de/ui.json" with { type: "json" };
import uiEn from "@restow/i18n/resources/en/ui.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `ui` namespace holds the strings of the shared kit (tables, dialogs,
 * tiles). Every kit module imports this file, so the bundle is registered
 * before the first kit component renders; once the shared package lists the
 * namespace, identical content merges harmlessly (deep merge, overwrite).
 */
export const UI_NAMESPACE = "ui";

i18n.addResourceBundle("de", UI_NAMESPACE, uiDe, true, true);
i18n.addResourceBundle("en", UI_NAMESPACE, uiEn, true, true);
