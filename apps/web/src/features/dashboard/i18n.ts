import dashboardDe from "@restow/i18n/resources/de/dashboard.json" with { type: "json" };
import dashboardEn from "@restow/i18n/resources/en/dashboard.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `dashboard` namespace ships with this feature. Every module of the
 * feature that renders text imports this file, so the current bundle is
 * registered before the first widget renders, whatever build of the shared
 * package is installed; identical content merges harmlessly (deep merge,
 * overwrite).
 */
export const DASHBOARD_NAMESPACE = "dashboard";

i18n.addResourceBundle("de", DASHBOARD_NAMESPACE, dashboardDe, true, true);
i18n.addResourceBundle("en", DASHBOARD_NAMESPACE, dashboardEn, true, true);
