import type { MiddlewareHandler } from "hono";
import type {
  ApiKeyContext,
  ApiKeyVariables,
  ApiScope,
  RequireApiKeyOptions,
  requireApiKey,
} from "../../../middleware/apiKey.js";
import { ProblemError } from "../../../problem.js";

/**
 * A stand-in for the API-key middleware with the same contract as
 * middleware/apiKey.ts (401 unknown key, 403 provider-only, 403 scope), backed
 * by a fixed token table instead of the `api_keys` lookup.
 */

export const TENANT_ID = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
export const OTHER_TENANT_ID = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";

const ALL_SCOPES: ApiScope[] = [
  "status:read",
  "jobs:read",
  "items:read",
  "users:read",
  "restore:write",
  "verify:write",
  "users:write",
  "archive:read",
  "webhooks:manage",
];

/**
 * A key context as the middleware builds it. Display fields the middleware may
 * carry (`name`, `prefix`) are filled too, so the table fits every revision.
 */
function testKey(keyId: string, tenantId: string | null, scopes: ApiScope[]): ApiKeyContext {
  return {
    keyId,
    name: `Test key ${keyId}`,
    prefix: `rsk_test_${keyId}`,
    tenantId,
    isProvider: tenantId === null,
    scopes,
  } as ApiKeyContext;
}

export const TEST_KEYS: Record<string, ApiKeyContext> = {
  rsk_tenant_full: testKey("key-tenant", TENANT_ID, ALL_SCOPES),
  rsk_tenant_status: testKey("key-status", TENANT_ID, ["status:read"]),
  rsk_provider_full: testKey("key-provider", null, ALL_SCOPES),
};

export const fakeRequireKey: typeof requireApiKey = (
  scope: ApiScope,
  options: RequireApiKeyOptions = {},
): MiddlewareHandler<{ Variables: ApiKeyVariables }> => {
  return async (c, next) => {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
    const key = TEST_KEYS[token];
    if (!key) {
      throw new ProblemError(401, "Invalid API key");
    }
    if (options.provider && !key.isProvider) {
      throw new ProblemError(403, "Provider key required");
    }
    if (!key.scopes.includes(scope)) {
      throw new ProblemError(403, "Insufficient scope", { extensions: { requiredScope: scope } });
    }
    c.set("apiKey", key);
    await next();
  };
};

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
