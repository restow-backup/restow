import accountsDe from "@restow/i18n/resources/de/accounts.json";
import accountsEn from "@restow/i18n/resources/en/accounts.json";

import { i18n } from "@/i18n";

/**
 * The `accounts` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace
 * too (packages/i18n/src/index.ts, an integration wiring request), identical
 * content merges harmlessly (deep merge, overwrite).
 */
export const ACCOUNTS_NAMESPACE = "accounts";

i18n.addResourceBundle("de", ACCOUNTS_NAMESPACE, accountsDe, true, true);
i18n.addResourceBundle("en", ACCOUNTS_NAMESPACE, accountsEn, true, true);
