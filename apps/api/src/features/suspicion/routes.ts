import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { requireTenant, type TenantEnv } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { falseAlarmSchema, idParamSchema, objectQuerySchema } from "./schemas.js";
import {
  listObjectSuspicions,
  listOpenSuspicions,
  markFalseAlarm,
  revokeFalseAlarm,
  type SuspicionActor,
} from "./service.js";

/**
 * /api/v1/suspicions: the ransomware judgements of restore points (docs/RANSOMWARE.md).
 *
 *   GET    /?kind=&objectId=       one object's judged restore points, newest first, whether an
 *                                  episode is open and the newest clean restore point
 *   GET    /open                   the tenant's objects whose newest restore point is suspicious
 *   POST   /:id/false-alarm        call a finding a false alarm ({ note }); audited
 *   DELETE /:id/false-alarm        take it back; audited
 *
 * For the tenant's administrators (provider admins by their team role, lib/provider-access.ts:
 * reading for every role, the false alarm for technicians and up).
 */

export interface SuspicionRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
}

function actorOf(c: Context<TenantEnv>): SuspicionActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

export function buildSuspicionRoutes(deps: SuspicionRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  const admin = deps.requireAdmin;

  routes.get("/", admin, async (c) => {
    const query = parseOrProblem(objectQuerySchema, c.req.query());
    return c.json(
      await listObjectSuspicions(deps.db, c.get("tenantId"), query.kind, query.objectId),
    );
  });

  routes.get("/open", admin, async (c) => {
    return c.json(await listOpenSuspicions(deps.db, c.get("tenantId")));
  });

  routes.post("/:id/false-alarm", admin, async (c) => {
    const { id } = parseOrProblem(idParamSchema, c.req.param());
    const input = await parseJsonBody(c.req, falseAlarmSchema);
    return c.json(
      await markFalseAlarm(deps.db, c.get("tenantId"), id, input.note ?? null, actorOf(c)),
    );
  });

  routes.delete("/:id/false-alarm", admin, async (c) => {
    const { id } = parseOrProblem(idParamSchema, c.req.param());
    return c.json(await revokeFalseAlarm(deps.db, c.get("tenantId"), id, actorOf(c)));
  });

  return routes;
}

export const suspicionRoutes = buildSuspicionRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
});
