import type { RunSizeGuardOverride } from "@restow/core";
import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { requireTenant, type TenantEnv } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  continueSchema,
  gibToBytes,
  idParamSchema,
  overrideFromRequest,
  raiseSchema,
  settingsSchema,
} from "./schemas.js";
import {
  continueRunSizeHold,
  listRunSizeHolds,
  type RunSizeActor,
  raiseRunSizeLimit,
  runSizeSettingsView,
  updateRunSizeSettings,
} from "./service.js";

/**
 * /api/v1/run-size: the backups the size and space guard held and its settings (#99,
 * docs/STORAGE.md "Unusually large runs"). For the tenant's administrators (provider admins by
 * their team role, lib/provider-access.ts: reading for every role, continuing once for
 * technicians and up, the limit and the settings for administrators and up).
 */

export interface RunSizeRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
}

function actorOf(c: Context<TenantEnv>): RunSizeActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

export function buildRunSizeRoutes(deps: RunSizeRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  const admin = deps.requireAdmin;

  routes.get("/holds", admin, async (c) =>
    c.json(await listRunSizeHolds(deps.db, c.get("tenantId"))),
  );

  routes.post("/holds/:id/continue", admin, async (c) => {
    const { id } = parseOrProblem(idParamSchema, c.req.param());
    const input = await parseJsonBody(c.req, continueSchema);
    return c.json(
      await continueRunSizeHold(deps.db, c.get("tenantId"), id, input.note ?? null, actorOf(c)),
    );
  });

  routes.post("/holds/:id/raise", admin, async (c) => {
    const { id } = parseOrProblem(idParamSchema, c.req.param());
    const input = await parseJsonBody(c.req, raiseSchema);
    return c.json(
      await raiseRunSizeLimit(
        deps.db,
        c.get("tenantId"),
        id,
        gibToBytes(input.limitGib),
        actorOf(c),
      ),
    );
  });

  routes.get("/settings", admin, async (c) =>
    c.json(await runSizeSettingsView(deps.db, c.get("tenantId"))),
  );

  routes.put("/settings", admin, async (c) => {
    const input = await parseJsonBody(c.req, settingsSchema);
    const scope =
      input.kind && input.objectId ? { kind: input.kind, objectId: input.objectId } : null;
    return c.json(
      await updateRunSizeSettings(
        deps.db,
        c.get("tenantId"),
        scope,
        input.override === null
          ? null
          : (overrideFromRequest(input.override) as RunSizeGuardOverride),
        actorOf(c),
      ),
    );
  });

  return routes;
}

export const runSizeRoutes = buildRunSizeRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
});
