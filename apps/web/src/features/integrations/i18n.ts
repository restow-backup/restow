import integrationsDe from "@restow/i18n/resources/de/integrations.json" with { type: "json" };
import integrationsEn from "@restow/i18n/resources/en/integrations.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `integrations` namespace ships with this feature. Registering it here
 * keeps the feature self-contained; once the shared package lists the
 * namespace, identical content merges harmlessly (deep merge, overwrite).
 */
export const INTEGRATIONS_NAMESPACE = "integrations";

i18n.addResourceBundle("de", INTEGRATIONS_NAMESPACE, integrationsDe, true, true);
i18n.addResourceBundle("en", INTEGRATIONS_NAMESPACE, integrationsEn, true, true);
