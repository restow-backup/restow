import suspicionDe from "@restow/i18n/resources/de/suspicion.json" with { type: "json" };
import suspicionEn from "@restow/i18n/resources/en/suspicion.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `suspicion` namespace: the badge of a suspicious restore point, the hint at the last clean
 * one, the findings, the false alarm and the thresholds of the ransomware detection.
 */
export const SUSPICION_NAMESPACE = "suspicion";

i18n.addResourceBundle("de", SUSPICION_NAMESPACE, suspicionDe, true, true);
i18n.addResourceBundle("en", SUSPICION_NAMESPACE, suspicionEn, true, true);
