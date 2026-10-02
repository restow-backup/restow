import installationDe from "@restow/i18n/resources/de/installation.json" with { type: "json" };
import installationEn from "@restow/i18n/resources/en/installation.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `installation` namespace ships with this feature. Registering it here
 * keeps the feature self-contained; once the shared package lists the
 * namespace, identical content merges harmlessly (deep merge, overwrite).
 */
export const INSTALLATION_NAMESPACE = "installation";

i18n.addResourceBundle("de", INSTALLATION_NAMESPACE, installationDe, true, true);
i18n.addResourceBundle("en", INSTALLATION_NAMESPACE, installationEn, true, true);
