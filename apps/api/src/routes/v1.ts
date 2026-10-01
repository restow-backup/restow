import { productName } from "@restow/i18n";
import { db as processDb, providerDb } from "../db.js";
import { integrationRouteRegistrars } from "../extensions.js";
import { updateState } from "../features/updates/state-instance.js";
import { audit } from "../lib/audit.js";
import { requireFeature } from "../lib/features.js";
import { requireApiKey } from "../middleware/apiKey.js";
import { IntegrationApi, type V1Deps } from "./v1/api.js";
import { registerArchiveRoutes } from "./v1/archive.js";
import { registerEndpointRoutes } from "./v1/endpoints.js";
import { registerJobRoutes } from "./v1/jobs.js";
import { registerObjectRoutes } from "./v1/objects.js";
import { type JsonSchema, buildOpenApiDocument } from "./v1/openapi.js";
import { registerRestoreRoutes } from "./v1/restore.js";
import { registerStatusRoutes } from "./v1/status.js";
import { registerStorageRoutes } from "./v1/storage.js";
import { registerTenantRoutes } from "./v1/tenant.js";
import { registerUserRoutes } from "./v1/users.js";
import { registerVerifyRoutes } from "./v1/verify.js";
import { registerWebhookRoutes } from "./v1/webhooks.js";

/**
 * The `/api/v1` REST surface for RMM/PSA integration
 * (docs/ARCHITECTURE.md, "API").
 *
 * Every operation needs a Restow API key with the scope it names; tenant
 * keys act on their own tenant, provider keys (while `apiKeys.provider` is on) on
 * the tenant named in `X-Restow-Tenant` and on the cross-tenant overviews.
 * Every read of user or backup data is written to the tenant's audit log;
 * changes are delegated to the feature services, which audit them in the same
 * transaction. Each area module under ./v1 defines its operations; the
 * OpenAPI description is generated from those definitions and served at
 * `/api/v1/openapi.json`.
 *
 * Mounting: the router only claims requests that carry an API key and passes
 * every other request on to the next route for the same path. Mount it
 * *before* the session-protected feature routes (`/jobs`, `/restore`,
 * `/verify`, `/webhooks`, ...) so integration calls reach it; the web UI's
 * session calls continue to the features unchanged.
 */

/** Version of the v1 contract; additive changes raise the minor version. */
export const V1_CONTRACT_VERSION = "1.0.0";

/** The API's description, naming the product the way this installation is branded. */
function describeApi(): string {
  return [
    `REST API of ${productName()} for RMM, PSA and ticket systems: backup, restore and verification status, jobs, the directory of protected users, storage, archive evidence and webhooks.`,
    "Conventions: JSON bodies; times are ISO 8601 in UTC; sizes are bytes; lists page with an opaque cursor (`next`, null on the last page) and at most 500 items; errors are RFC 7807 problem details (`application/problem+json`).",
    "Authentication: `Authorization: Bearer rsk_...`. Each key is limited to 600 requests per 10 minutes. Every read of user or backup data is recorded in the tenant's audit log.",
  ].join("\n\n");
}

export function buildV1(deps: V1Deps): IntegrationApi {
  const api = new IntegrationApi(deps);

  registerTenantRoutes(api, deps);
  registerStatusRoutes(api, deps);
  registerStorageRoutes(api, deps);
  registerObjectRoutes(api, deps);
  registerEndpointRoutes(api, deps);
  registerUserRoutes(api, deps);
  registerJobRoutes(api, deps);
  registerVerifyRoutes(api, deps);
  registerRestoreRoutes(api, deps);
  registerArchiveRoutes(api, deps);
  registerWebhookRoutes(api, deps);
  // Operations contributed by extensions (../extensions.ts); each extension
  // decides itself whether its operations answer.
  for (const register of integrationRouteRegistrars()) {
    register(api, deps);
  }

  // Built on the first request, when every operation above is registered.
  let document: JsonSchema | null = null;
  api.document("/openapi.json", () => {
    document ??= buildOpenApiDocument(api.operations, {
      title: `${productName()} Integration API`,
      version: V1_CONTRACT_VERSION,
      description: describeApi(),
      build: deps.version.current().running,
    });
    return document;
  });

  return api;
}

/**
 * The running version and the update check (features/updates), shared by the
 * integration API and the web UI's status route so both report the same state
 * from one background check. The check is off until an administrator turns it
 * on (or the operator sets RESTOW_UPDATE_CHECK_URL).
 */
export const versionSource = updateState;

const integrationApi = buildV1({
  db: processDb,
  providerDb,
  requireKey: requireApiKey,
  requireFeature,
  audit,
  version: versionSource,
  now: () => new Date(),
});

/** The router mounted at `/api/v1`. */
export const v1 = integrationApi.app;

/** Every operation of the surface, as documented in the OpenAPI description. */
export const v1Operations = integrationApi.operations;
