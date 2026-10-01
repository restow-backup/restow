import schedulesDe from "@restow/i18n/resources/de/schedules.json" with { type: "json" };
import schedulesEn from "@restow/i18n/resources/en/schedules.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `schedules` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace,
 * identical content merges harmlessly (deep merge, overwrite).
 */
export const SCHEDULES_NAMESPACE = "schedules";

i18n.addResourceBundle("de", SCHEDULES_NAMESPACE, schedulesDe, true, true);
i18n.addResourceBundle("en", SCHEDULES_NAMESPACE, schedulesEn, true, true);
