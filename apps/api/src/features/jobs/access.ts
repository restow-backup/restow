import type { MiddlewareHandler } from "hono";
import {
  type ApiScope,
  type TenantAccessEnv,
  requireTenantOrApiKey,
} from "../../middleware/apiKey.js";

/**
 * Who may use /api/v1/jobs, and on which tenant.
 *
 * The same endpoints serve two callers (docs/ARCHITECTURE.md, "API"): the
 * web UI with a session (tenant admins and provider admins, tenant from
 * `X-Restow-Tenant`) and RMM/PSA integrations with an API key and a scope
 * (`Authorization: Bearer rsk_...`; a tenant key acts on its own tenant, a
 * provider key names the tenant in `X-Restow-Tenant`). Keys follow the shared
 * tenant rules of every key surface (features/apikeys/key-tenant.ts). Either
 * way the handlers see `tenantId` and an `actor` for the audit log.
 */

export type JobsEnv = TenantAccessEnv;

/**
 * Require a tenant admin session or an API key with `scope`. Sets `tenantId`
 * and `actor` for the handlers.
 */
export function requireJobsAccess(scope: ApiScope): MiddlewareHandler<JobsEnv> {
  return requireTenantOrApiKey(scope, "tenant_admin");
}
