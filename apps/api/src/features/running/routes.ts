import { Hono } from "hono";
import { db, providerDb } from "../../db.js";
import { requireProviderAdmin, type SessionEnv } from "../../middleware/session.js";
import { TenantFiguresCache } from "../tenant-jobs/figures-cache.js";
import { type AllTenantsRunningDeps, loadAllTenantsRunning, RUNNING_TTL_MS } from "./tenants.js";

/**
 * /api/v1/tenant-running: what is being copied or backed up right now in every tenant, for the
 * provider's "All tenants" start page. Provider admins only (a tenant's own administrators have
 * the widget on their tenant's start page); a member of the provider team limited to some
 * tenants sees those, like the tenant list (lib/provider-access.ts).
 *
 *   GET /   the tenants that have something running, each with its runs, and the next planned start
 *
 * tenants.ts says which pool reads what.
 */

export interface TenantRunningRoutesDeps extends AllTenantsRunningDeps {
  now?: () => Date;
}

export function createTenantRunningRoutes(deps: TenantRunningRoutesDeps): Hono<SessionEnv> {
  const now = deps.now ?? (() => new Date());
  const shared: AllTenantsRunningDeps = {
    ...deps,
    cache: deps.cache ?? new TenantFiguresCache(RUNNING_TTL_MS),
  };
  const routes = new Hono<SessionEnv>();
  routes.get("/", requireProviderAdmin, async (c) =>
    c.json(await loadAllTenantsRunning(shared, c.get("providerAccess"), now())),
  );
  return routes;
}

export const tenantRunningRoutes = createTenantRunningRoutes({ db, providerDb });
