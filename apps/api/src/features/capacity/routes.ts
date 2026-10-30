import { Hono } from "hono";
import { z } from "zod";
import { db, providerDb } from "../../db.js";
import { currentInstallationDefault } from "../../lib/installation-default.js";
import { requireProviderAdmin, type SessionEnv } from "../../middleware/session.js";
import { parseOrProblem } from "../../schemas.js";
import {
  type CapacityDeps,
  capacityFiguresCache,
  loadCapacity,
  loadTenantCapacity,
} from "./service.js";

/**
 * /api/v1/capacity — utilisation and growth per tenant and per repository, with a plain estimate
 * of when a repository runs full (service.ts). Provider admins only; a member of the provider
 * team limited to some tenants sees those, like the tenant list (lib/provider-access.ts). The
 * list of every tenant needs the gate `dashboard.allTenants`; without it the answer is the one
 * tenant of the installation.
 */

const tenantParamSchema = z.object({ tenantId: z.string().uuid() });

export function createCapacityRoutes(deps: CapacityDeps): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();

  routes.get("/", requireProviderAdmin, async (c) => {
    return c.json(await loadCapacity(deps, c.get("providerAccess")));
  });

  routes.get("/:tenantId", requireProviderAdmin, async (c) => {
    const { tenantId } = parseOrProblem(tenantParamSchema, c.req.param());
    return c.json(await loadTenantCapacity(deps, c.get("providerAccess"), tenantId));
  });

  return routes;
}

export const capacityRoutes = createCapacityRoutes({
  db,
  providerDb,
  env: process.env,
  installationDefault: currentInstallationDefault,
  cache: capacityFiguresCache,
});
