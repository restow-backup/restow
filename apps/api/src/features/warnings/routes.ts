import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { acknowledgeSchema, listQuerySchema, targetParamSchema } from "./schemas.js";
import {
  type WarningActor,
  acknowledgeWarnings,
  getWarning,
  listWarnings,
  revokeAcknowledgement,
} from "./service.js";

/**
 * /api/v1/warnings: backups that went through but left items behind, why, and their
 * acknowledgements (packages/core/src/failures/warnings.ts).
 *
 *   GET    /                              open and acknowledged warnings (?state=open|acknowledged|all)
 *   GET    /:kind/:id                     one object (`object`) or machine (`machine`): its newest runs,
 *                                         the failed items of the newest one by cause, the acknowledgement
 *   POST   /acknowledge                   acknowledge the warnings of one or many ({ targets, note })
 *   DELETE /:kind/:id/acknowledgement     revoke an acknowledgement
 *
 * For the tenant's administrators (provider admins by their team role, lib/provider-access.ts:
 * reading for every role, acknowledging for technicians and up). Every change is audited.
 */

export interface WarningsRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
}

function actorOf(c: Context<TenantEnv>): WarningActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

export function buildWarningsRoutes(deps: WarningsRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  const admin = deps.requireAdmin;

  routes.get("/", admin, async (c) => {
    const query = parseOrProblem(listQuerySchema, c.req.query());
    return c.json(await listWarnings(deps.db, c.get("tenantId"), { state: query.state }));
  });

  routes.post("/acknowledge", admin, async (c) => {
    const input = await parseJsonBody(c.req, acknowledgeSchema);
    return c.json(await acknowledgeWarnings(deps.db, c.get("tenantId"), input, actorOf(c)));
  });

  routes.get("/:kind/:id", admin, async (c) => {
    const { kind, id } = parseOrProblem(targetParamSchema, c.req.param());
    return c.json(await getWarning(deps.db, c.get("tenantId"), kind, id));
  });

  routes.delete("/:kind/:id/acknowledgement", admin, async (c) => {
    const { kind, id } = parseOrProblem(targetParamSchema, c.req.param());
    await revokeAcknowledgement(deps.db, c.get("tenantId"), { kind, id }, actorOf(c));
    return c.body(null, 204);
  });

  return routes;
}

export const warningsRoutes = buildWarningsRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
});
