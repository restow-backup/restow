import warningsDe from "@restow/i18n/resources/de/warnings.json" with { type: "json" };
import warningsEn from "@restow/i18n/resources/en/warnings.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `warnings` namespace: the warnings page, the sheet that explains one object's warning and
 * the acknowledge dialog, registered here like every feature's own namespace.
 */
export const WARNINGS_NAMESPACE = "warnings";

i18n.addResourceBundle("de", WARNINGS_NAMESPACE, warningsDe, true, true);
i18n.addResourceBundle("en", WARNINGS_NAMESPACE, warningsEn, true, true);
