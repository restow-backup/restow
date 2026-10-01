import endpointsDe from "@restow/i18n/resources/de/endpoints.json" with { type: "json" };
import endpointsEn from "@restow/i18n/resources/en/endpoints.json" with { type: "json" };

import { i18n } from "@/i18n";

/** The `endpoints` namespace ships with this feature (see schedules/i18n.ts). */
export const ENDPOINTS_NAMESPACE = "endpoints";

i18n.addResourceBundle("de", ENDPOINTS_NAMESPACE, endpointsDe, true, true);
i18n.addResourceBundle("en", ENDPOINTS_NAMESPACE, endpointsEn, true, true);
