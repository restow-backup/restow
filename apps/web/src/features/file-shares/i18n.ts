import fileSharesDe from "@restow/i18n/resources/de/fileshares.json" with { type: "json" };
import fileSharesEn from "@restow/i18n/resources/en/fileshares.json" with { type: "json" };

import { i18n } from "@/i18n";

/** The `fileshares` namespace ships with this feature (see endpoints/i18n.ts). */
export const FILESHARES_NAMESPACE = "fileshares";

i18n.addResourceBundle("de", FILESHARES_NAMESPACE, fileSharesDe, true, true);
i18n.addResourceBundle("en", FILESHARES_NAMESPACE, fileSharesEn, true, true);
