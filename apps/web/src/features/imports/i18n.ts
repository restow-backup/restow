import importsDe from "@restow/i18n/resources/de/imports.json" with { type: "json" };
import importsEn from "@restow/i18n/resources/en/imports.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `imports` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package is rebuilt, identical
 * content merges harmlessly (deep merge, overwrite).
 */
export const IMPORTS_NAMESPACE = "imports";

i18n.addResourceBundle("de", IMPORTS_NAMESPACE, importsDe, true, true);
i18n.addResourceBundle("en", IMPORTS_NAMESPACE, importsEn, true, true);
