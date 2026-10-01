import directoryDe from "@restow/i18n/resources/de/directory.json";
import directoryEn from "@restow/i18n/resources/en/directory.json";

import { i18n } from "@/i18n";

/**
 * The `directory` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace,
 * identical content merges harmlessly (deep merge, overwrite).
 */
export const DIRECTORY_NAMESPACE = "directory";

i18n.addResourceBundle("de", DIRECTORY_NAMESPACE, directoryDe, true, true);
i18n.addResourceBundle("en", DIRECTORY_NAMESPACE, directoryEn, true, true);
