import { Hono } from "hono";
import { z } from "zod";
import { db, providerDb } from "../../db.js";
import { requireProviderAdmin, type SessionEnv } from "../../middleware/session.js";
import { parseOrProblem } from "../../schemas.js";
import { TenantFiguresCache } from "./figures-cache.js";
import { loadTenantJobSummaries, loadTenantJobs, type TenantJobsDeps } from "./service.js";

/**
 * /api/v1/tenant-jobs — the jobs of every tenant at a glance, for the provider's "All tenants"
 * view of Jobs (#63). Provider admins only (a tenant's own administrators have their tenant's
 * Jobs page); a member of the provider team limited to some tenants sees those, like the tenant
 * list (lib/provider-access.ts).
 *
 *   GET /             every tenant with its mail, machine and Proxmox VE jobs counted: jobs,
 *                     paused, running and waiting backups, how the newest backups ended, the
 *                     last and the next run
 *   GET /:tenantId    one tenant's jobs, read-only: name, scope, schedule, last and next run, state
 *
 * service.ts says which pool reads what: the tenant list on the installation pool, every
 * tenant's figures on the application pool in that tenant's pinned transaction. The figures of
 * the overview are kept for half a minute for every viewer (figures-cache.ts); one tenant's jobs
 * are always read fresh.
 */

export interface TenantJobsRoutesDeps extends TenantJobsDeps {
  now?: () => Date;
}

const tenantParamSchema = z.object({ tenantId: z.string().uuid() });

export function createTenantJobsRoutes(deps: TenantJobsRoutesDeps): Hono<SessionEnv> {
  const now = deps.now ?? (() => new Date());
  const summaryDeps: TenantJobsDeps = {
    ...deps,
    figures: deps.figures ?? new TenantFiguresCache(),
  };
  const routes = new Hono<SessionEnv>();

  routes.get("/", requireProviderAdmin, async (c) => {
    return c.json(await loadTenantJobSummaries(summaryDeps, c.get("providerAccess"), now()));
  });

  routes.get("/:tenantId", requireProviderAdmin, async (c) => {
    const { tenantId } = parseOrProblem(tenantParamSchema, c.req.param());
    return c.json(await loadTenantJobs(deps, tenantId, now()));
  });

  return routes;
}

export const tenantJobsRoutes = createTenantJobsRoutes({ db, providerDb });
