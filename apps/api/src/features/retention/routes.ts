import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  createRetentionPolicySchema,
  previewRetentionPolicySchema,
  retentionPolicyParamSchema,
  updateRetentionPolicySchema,
} from "./schemas.js";
import {
  type RetentionActor,
  createRetentionPolicy,
  deleteRetentionPolicy,
  listRetentionPolicies,
  previewRetentionPolicy,
  updateRetentionPolicy,
} from "./service.js";

/**
 * /api/v1/retention/policies — how long backup snapshots (restore points) are
 * kept: the tenant default plus any per-object overrides.
 *
 *   GET    /policies          every policy of the tenant
 *   POST   /policies/preview  what the next run would remove for a draft (nothing saved)
 *   POST   /policies          create
 *   PATCH  /policies/:id      change
 *   DELETE /policies/:id      delete
 *
 * The whole feature is tenant-administrator only (retention shapes what
 * backup data survives at all); every change is audited in the same
 * transaction. Invalid policies are 422 problems that name the field
 * (`field`, `issues[0].path`).
 */

export interface RetentionRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
  /** Injectable clock (tests pin it). */
  now?: () => Date;
}

function actorOf(c: Context<TenantEnv>): RetentionActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

export function buildRetentionRoutes(deps: RetentionRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  const now = deps.now ?? (() => new Date());

  routes.get("/policies", deps.requireAdmin, async (c) => {
    return c.json(await listRetentionPolicies(deps.db, c.get("tenantId")));
  });

  // Static path before `/policies/:id`, so it is never read as a policy id.
  routes.post("/policies/preview", deps.requireAdmin, async (c) => {
    const input = await parseJsonBody(c.req, previewRetentionPolicySchema);
    return c.json(await previewRetentionPolicy(deps.db, c.get("tenantId"), input, now()));
  });

  routes.post("/policies", deps.requireAdmin, async (c) => {
    const input = await parseJsonBody(c.req, createRetentionPolicySchema);
    return c.json(await createRetentionPolicy(deps.db, c.get("tenantId"), input, actorOf(c)), 201);
  });

  routes.patch("/policies/:id", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(retentionPolicyParamSchema, c.req.param());
    const patch = await parseJsonBody(c.req, updateRetentionPolicySchema);
    return c.json(await updateRetentionPolicy(deps.db, c.get("tenantId"), id, patch, actorOf(c)));
  });

  routes.delete("/policies/:id", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(retentionPolicyParamSchema, c.req.param());
    await deleteRetentionPolicy(deps.db, c.get("tenantId"), id, actorOf(c));
    return c.body(null, 204);
  });

  return routes;
}

export const retentionRoutes = buildRetentionRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
});
