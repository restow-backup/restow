import backupjobsDe from "@restow/i18n/resources/de/backupjobs.json" with { type: "json" };
import backupjobsEn from "@restow/i18n/resources/en/backupjobs.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `backupjobs` namespace ships with this feature. The keys under `auto.*`
 * are the server's (the names the migration gives the jobs it creates); the
 * rest are the screens. Registering the files here keeps the feature current
 * even while the shared package's build output lags behind.
 */
export const BACKUP_JOBS_NAMESPACE = "backupjobs";

i18n.addResourceBundle("de", BACKUP_JOBS_NAMESPACE, backupjobsDe, true, true);
i18n.addResourceBundle("en", BACKUP_JOBS_NAMESPACE, backupjobsEn, true, true);
