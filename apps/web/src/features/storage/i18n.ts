import storageDe from "@restow/i18n/resources/de/storage.json" with { type: "json" };
import storageEn from "@restow/i18n/resources/en/storage.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `storage` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace,
 * identical content merges harmlessly (deep merge, overwrite).
 */
export const STORAGE_NAMESPACE = "storage";

i18n.addResourceBundle("de", STORAGE_NAMESPACE, storageDe, true, true);
i18n.addResourceBundle("en", STORAGE_NAMESPACE, storageEn, true, true);
