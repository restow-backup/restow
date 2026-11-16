import type { RunSizeGuardOverride, RunSpaceOverride } from "@restow/core";
import { type Database, loadInstallationSpaceRule } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db, providerDb } from "../../db.js";
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
  spaceFromRequest,
  spaceRuleSchema,
  targetParamSchema,
} from "./schemas.js";
import {
  continueRunSizeHold,
  type InstallationSpaceRule,
  listRunSizeHolds,
  type RunSizeActor,
  raiseRunSizeLimit,
  runSizeSettingsView,
  targetSpaceRules,
  updateRunSizeSettings,
  updateTargetSpaceRule,
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
  /** The installation's space rule, read on the installation pool (the tenant role cannot). */
  installationSpace?: InstallationSpaceRule;
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
    c.json(await runSizeSettingsView(deps.db, c.get("tenantId"), deps.installationSpace)),
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
        {
          ...(input.override === undefined
            ? {}
            : {
                override:
                  input.override === null
                    ? null
                    : (overrideFromRequest(input.override) as RunSizeGuardOverride),
              }),
          ...(input.space === undefined
            ? {}
            : {
                space:
                  input.space === null ? null : (spaceFromRequest(input.space) as RunSpaceOverride),
              }),
        },
        actorOf(c),
        new Date(),
        deps.installationSpace,
      ),
    );
  });

  // The space rule of each of the tenant's own storage targets (the storage page shows it).
  routes.get("/targets", admin, async (c) =>
    c.json(await targetSpaceRules(deps.db, c.get("tenantId"), deps.installationSpace)),
  );

  routes.put("/targets/:id", admin, async (c) => {
    const { id } = parseOrProblem(targetParamSchema, c.req.param());
    const input = await parseJsonBody(c.req, spaceRuleSchema);
    return c.json(
      await updateTargetSpaceRule(
        deps.db,
        c.get("tenantId"),
        id,
        input.space === null ? null : (spaceFromRequest(input.space) as RunSpaceOverride),
        actorOf(c),
        new Date(),
        deps.installationSpace,
      ),
    );
  });

  return routes;
}

export const runSizeRoutes = buildRunSizeRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
  installationSpace: () => loadInstallationSpaceRule(providerDb),
});
