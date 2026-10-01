import verifyDe from "@restow/i18n/resources/de/verify.json";
import verifyEn from "@restow/i18n/resources/en/verify.json";

import { i18n } from "@/i18n";

/**
 * The `verify` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace,
 * identical content merges harmlessly (deep merge, overwrite).
 */
export const VERIFY_NAMESPACE = "verify";

i18n.addResourceBundle("de", VERIFY_NAMESPACE, verifyDe, true, true);
i18n.addResourceBundle("en", VERIFY_NAMESPACE, verifyEn, true, true);
