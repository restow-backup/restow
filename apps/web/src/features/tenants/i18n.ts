import tenantsDe from "@restow/i18n/resources/de/tenants.json";
import tenantsEn from "@restow/i18n/resources/en/tenants.json";

import { i18n } from "@/i18n";

/**
 * The `tenants` namespace ships with this feature. Registering it here keeps
 * the feature self-contained; once the shared package lists the namespace,
 * identical content merges harmlessly (deep merge, overwrite).
 */
export const TENANTS_NAMESPACE = "tenants";

i18n.addResourceBundle("de", TENANTS_NAMESPACE, tenantsDe, true, true);
i18n.addResourceBundle("en", TENANTS_NAMESPACE, tenantsEn, true, true);
