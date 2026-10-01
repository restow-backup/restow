import exportsDe from "@restow/i18n/resources/de/exports.json" with { type: "json" };
import exportsEn from "@restow/i18n/resources/en/exports.json" with { type: "json" };

import { i18n } from "@/i18n";

/** The `exports` namespace ships with this feature (see features/archive/i18n.ts for the pattern). */
export const EXPORTS_NAMESPACE = "exports";

i18n.addResourceBundle("de", EXPORTS_NAMESPACE, exportsDe, true, true);
i18n.addResourceBundle("en", EXPORTS_NAMESPACE, exportsEn, true, true);
