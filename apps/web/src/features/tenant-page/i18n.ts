import tenantpageDe from "@restow/i18n/resources/de/tenantpage.json" with { type: "json" };
import tenantpageEn from "@restow/i18n/resources/en/tenantpage.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `tenantpage` namespace ships with this feature. Registering it here
 * keeps the feature self-contained; once the shared package lists the
 * namespace, identical content merges harmlessly (deep merge, overwrite).
 */
export const TENANT_PAGE_NAMESPACE = "tenantpage";

i18n.addResourceBundle("de", TENANT_PAGE_NAMESPACE, tenantpageDe, true, true);
i18n.addResourceBundle("en", TENANT_PAGE_NAMESPACE, tenantpageEn, true, true);
