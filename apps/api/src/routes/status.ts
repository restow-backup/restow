import { Hono } from "hono";
import { db } from "../db.js";
import { loadShareCounts } from "../features/file-shares/protection.js";
import { loadGuestCounts } from "../features/pve/protection.js";
import { type TenantEnv, requireTenant } from "../middleware/session.js";
import { versionSource } from "./v1.js";
import { loadEndpointCounts } from "./v1/endpoints.js";
import { type StatusDto, loadTenantSummary } from "./v1/status.js";

/**
 * GET /api/v1/status for the web UI: the dashboard summary of the active
 * tenant (last success per type, protected and failed objects, storage,
 * recovery readiness, archive chain, running version) for a signed-in member.
 *
 * It answers with exactly the document the integration API serves to API
 * keys on the same path (routes/v1/status.ts, `Status` in the OpenAPI
 * description), so there is one shape for one path. The v1 router claims
 * requests that carry an API key and passes session requests on to this
 * route; mount it after the v1 router. The summary holds counts and dates
 * only, no user data, so every member of the tenant may read it.
 */
export const status = new Hono<TenantEnv>();

status.get("/", requireTenant("tenant_user"), async (c) => {
  const tenant = c.get("tenant");
  const now = new Date();
  const summary = await loadTenantSummary(db, tenant.id, now);
  const body: StatusDto = {
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
    generatedAt: now.toISOString(),
    ...summary,
    version: versionSource.current(),
    endpoints: await loadEndpointCounts(db, tenant.id, now),
    guests: (await loadGuestCounts(db, tenant.id, now)).counts,
    fileShares: (await loadShareCounts(db, tenant.id, now)).counts,
  };
  return c.json(body);
});
