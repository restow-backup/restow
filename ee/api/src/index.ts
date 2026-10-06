import type { ApiExtension } from "../../../apps/api/src/extensions.js";
import { auditLogRoutes } from "./audit-log/routes.js";
import { journalRoutes } from "./journal/routes.js";
import { journalReceiverService } from "./journal/service.js";
import { legalHoldRoutes } from "./legal-holds/routes.js";
import { licenseFeatureGate } from "./license/gate.js";
import { pendingLicenseKeyService } from "./license/pending.js";
import { licenseRouteContribution } from "./license/routes.js";
import { editionSessionField } from "./license/session.js";
import { registerProviderRoutes } from "./provider-api/routes.js";
import { providerDashboardLoader } from "./provider-dashboard/view.js";
import { eeProviderRouteRules } from "./provider-rules.js";
import { reportsExtensionHooks } from "./reports/summary.js";
import { microsoftSignInGuard, microsoftSignInProvider } from "./sso/access.js";

/**
 * Entry of the Business and Service Provider API modules (ee/README.md),
 * loaded by apps/api/src/ee.ts. Each feature contributes its routes,
 * listeners and hooks here and guards them itself with the license gate
 * (./license/gate.ts); the license module adds the key management routes,
 * the core's feature gate and the edition of the session.
 */
export const eeApiExtension: ApiExtension = {
  name: "ee",
  sessionRoutes: [licenseRouteContribution, auditLogRoutes, journalRoutes, legalHoldRoutes],
  integrationRoutes: [registerProviderRoutes],
  authRouteGuards: [microsoftSignInGuard],
  signInProviders: [microsoftSignInProvider],
  services: [journalReceiverService, pendingLicenseKeyService],
  hooks: { ...reportsExtensionHooks, providerDashboard: providerDashboardLoader },
  featureGate: licenseFeatureGate,
  sessionFields: [editionSessionField],
  providerRouteRules: eeProviderRouteRules,
};
