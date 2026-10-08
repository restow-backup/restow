import pveDe from "@restow/i18n/resources/de/pve.json" with { type: "json" };
import pveEn from "@restow/i18n/resources/en/pve.json" with { type: "json" };

import { i18n } from "@/i18n";

/** The `pve` namespace ships with this feature (see endpoints/i18n.ts). */
export const PVE_NAMESPACE = "pve";

i18n.addResourceBundle("de", PVE_NAMESPACE, pveDe, true, true);
i18n.addResourceBundle("en", PVE_NAMESPACE, pveEn, true, true);
