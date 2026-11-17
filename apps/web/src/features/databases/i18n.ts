import databasesDe from "@restow/i18n/resources/de/databases.json" with { type: "json" };
import databasesEn from "@restow/i18n/resources/en/databases.json" with { type: "json" };

import { i18n } from "@/i18n";

/** The `databases` namespace ships with this feature (see endpoints/i18n.ts). */
export const DATABASES_NAMESPACE = "databases";

i18n.addResourceBundle("de", DATABASES_NAMESPACE, databasesDe, true, true);
i18n.addResourceBundle("en", DATABASES_NAMESPACE, databasesEn, true, true);
