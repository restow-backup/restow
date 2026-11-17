import type { ProviderRouteRule } from "../../../apps/api/src/lib/provider-access.js";
import { providerRule } from "../../../apps/api/src/lib/provider-access.js";

const { view, configure, own, scope } = providerRule;

/**
 * Provider team rules (apps/api/src/lib/provider-access.ts) for the routes
 * the Business and Service Provider modules register, contributed through
 * the core's extension point (`ApiExtension.providerRouteRules`). Keyed
 * `METHOD /path` exactly as the router registers it; ./provider-access.test.ts
 * checks that the assembled app has a rule for every route and no rule for a
 * route that does not exist.
 */
export const eeProviderRouteRules: Readonly<Record<string, ProviderRouteRule>> = {
  // The license key: reading for every provider admin, changing it for owners.
  "GET /api/v1/license": view(scope.provider),
  "POST /api/v1/license": own(),
  "DELETE /api/v1/license": own(),

  // The audit log viewer.
  "GET /api/v1/audit": view(),
  "GET /api/v1/audit/:id": view(),
  "GET /api/v1/audit/actions": view(),
  "GET /api/v1/audit/verify": view(),
  "GET /api/v1/audit/export": view(),

  // Legal holds.
  "GET /api/v1/archive/legal-holds": view(),
  "POST /api/v1/archive/legal-holds": configure(),
  "DELETE /api/v1/archive/legal-holds/:id": configure(),

  // Journal setup. The journal address is a credential: it is the only thing the
  // SMTP receiver checks, so whoever knows it can deliver mail into the tenant's
  // archive. Comparable secrets (API keys, webhook secrets, enrolment tokens, an
  // endpoint's repository password, set-password links) are issued and shown at
  // the configure level and never to technicians or read-only members, so the
  // address is handled the same way. The first read issues the address (a write,
  // with an audit entry), which a view-level route must not do either. Rotating
  // it stops the old address at once, so journal reports are refused until the
  // Exchange Online rule has the new one: configuration work too.
  "GET /api/v1/archive/journal": configure(),
  "POST /api/v1/archive/journal/rotate": configure(),
  // The receiver itself (port, TLS, host, limits, whether it listens) belongs to the
  // installation, not to a tenant, and holds no address: every provider admin may read it,
  // but not a member limited to some tenants (it concerns all of them).
  "GET /api/v1/archive/journal/receiver": view(scope.provider),
  // The journal host alone (the tenant page): installation configuration, no address, no write.
  "GET /api/v1/archive/journal/host": view(),

  // Forwarded copies (0.4.4). An account's archive address is a credential like the journal
  // address (whoever knows it can deliver into that account's archive), so reading the list
  // with the addresses, issuing and rotating are configuration work.
  "GET /api/v1/archive/forwarding": configure(),
  "POST /api/v1/archive/forwarding/:objectId/address": configure(),
  "POST /api/v1/archive/forwarding/:objectId/rotate": configure(),

  // The cross-tenant provider API, reachable with a session too.
  "GET /api/v1/provider/billing": view(scope.provider),
  // The closed billing months (0.6.0): read like the live figures; a correction changes what a
  // customer is billed, so only an owner may enter one.
  "GET /api/v1/provider/billing/periods": view(scope.provider),
  "GET /api/v1/provider/billing/periods/:period": view(scope.provider),
  "POST /api/v1/provider/billing/periods/:period/corrections": own(),
  // The provider's own webhooks (0.6.0): managed by the owner, like the provider API keys.
  "GET /api/v1/provider/webhooks": view(scope.provider),
  "POST /api/v1/provider/webhooks": own(),
  "GET /api/v1/provider/webhooks/:id": view(scope.provider),
  "PATCH /api/v1/provider/webhooks/:id": own(),
  "DELETE /api/v1/provider/webhooks/:id": own(),
  "POST /api/v1/provider/webhooks/:id/secret": own(),
  "POST /api/v1/provider/webhooks/:id/test": own(),
  "GET /api/v1/provider/webhooks/:id/deliveries": view(scope.provider),
  "GET /api/v1/provider-webhooks": view(scope.provider),
  "POST /api/v1/provider-webhooks": own(),
  "PATCH /api/v1/provider-webhooks/:id": own(),
  "DELETE /api/v1/provider-webhooks/:id": own(),
  "POST /api/v1/provider-webhooks/:id/secret": own(),
  "POST /api/v1/provider-webhooks/:id/test": own(),
  "GET /api/v1/provider-webhooks/:id/deliveries": view(scope.provider),

  // Installation › Billing (0.6.0): every provider role reads the closed months, the owner
  // corrects one.
  "GET /api/v1/billing/periods": view(scope.provider),
  "GET /api/v1/billing/periods/:period": view(scope.provider),
  "GET /api/v1/billing/periods/:period/csv": view(scope.provider),
  "POST /api/v1/billing/periods/:period/corrections": own(),
  "GET /api/v1/provider/tenants": view(scope.provider),
  "GET /api/v1/provider/users": view(scope.provider),
};
