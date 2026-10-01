import backupDe from "@restow/i18n/resources/de/backup.json";
import backupEn from "@restow/i18n/resources/en/backup.json";

import { i18n } from "@/i18n";

/**
 * The `backup` namespace ships with the shared package; registering the
 * resource files here keeps this feature current even while the package's
 * build output lags behind (identical content merges harmlessly).
 */
export const BACKUP_NAMESPACE = "backup";

i18n.addResourceBundle("de", BACKUP_NAMESPACE, backupDe, true, true);
i18n.addResourceBundle("en", BACKUP_NAMESPACE, backupEn, true, true);
