import auditDe from "@restow/i18n/resources/de/audit.json" with { type: "json" };
import auditEn from "@restow/i18n/resources/en/audit.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `audit` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace,
 * identical content merges harmlessly (deep merge, overwrite).
 */
export const AUDIT_NAMESPACE = "audit";

i18n.addResourceBundle("de", AUDIT_NAMESPACE, auditDe, true, true);
i18n.addResourceBundle("en", AUDIT_NAMESPACE, auditEn, true, true);
