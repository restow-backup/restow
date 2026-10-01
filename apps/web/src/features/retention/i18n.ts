import retentionDe from "@restow/i18n/resources/de/retention.json" with { type: "json" };
import retentionEn from "@restow/i18n/resources/en/retention.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `retention` namespace ships with this feature. Registering it here
 * keeps the feature self-contained; once the shared package lists the
 * namespace, identical content merges harmlessly (deep merge, overwrite).
 */
export const RETENTION_NAMESPACE = "retention";

i18n.addResourceBundle("de", RETENTION_NAMESPACE, retentionDe, true, true);
i18n.addResourceBundle("en", RETENTION_NAMESPACE, retentionEn, true, true);
