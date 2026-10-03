import { Hono, type MiddlewareHandler } from "hono";
import { db, providerDb } from "../../db.js";
import { currentInstallationDefault } from "../../lib/installation-default.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseOrProblem } from "../../schemas.js";
import { dashboardQuerySchema } from "./schemas.js";
import { type DashboardDeps, loadDashboard } from "./service.js";

/**
 * /api/v1/dashboard — the start page in one request: the tenant widgets that
 * apply to the viewer and, on request, the provider view (see meta.ts).
 * Open to every member of the tenant; the service leaves out what a plain
 * member may not see and refuses the provider view to anyone but a provider
 * admin, and while `dashboard.allTenants` is off (lib/features.ts).
 */

export interface DashboardRouteDeps extends DashboardDeps {
  /** Authenticates the request and resolves the tenant (requireTenant in production). */
  access: MiddlewareHandler<TenantEnv>;
}

export function createDashboardRoutes(deps: DashboardRouteDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();

  routes.get("/", deps.access, async (c) => {
    const query = parseOrProblem(dashboardQuerySchema, c.req.query());
    const viewer = {
      tenant: c.get("tenant"),
      role: c.get("role"),
      isProviderAdmin: c.get("isProviderAdmin"),
      providerAllTenants: c.get("providerAccess")?.allTenants ?? true,
    };
    return c.json(await loadDashboard(deps, viewer, query));
  });

  return routes;
}

export const dashboardRoutes = createDashboardRoutes({
  db,
  providerDb,
  env: process.env,
  defaultStorageConfigured: async () => (await currentInstallationDefault()) !== null,
  now: () => new Date(),
  access: requireTenant("tenant_user"),
});
