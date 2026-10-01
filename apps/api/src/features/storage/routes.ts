import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  createStorageTargetSchema,
  migrationIdParamSchema,
  probeStorageSchema,
  targetIdParamSchema,
  updateStorageTargetSchema,
} from "./schemas.js";
import {
  type Actor,
  cancelMigration,
  checkCompleteness,
  createTarget,
  deleteTarget,
  getTarget,
  listTargets,
  probeSettings,
  promoteTarget,
  retryMigration,
  storageUsage,
  testInstallationDefault,
  testTarget,
  updateTarget,
} from "./service.js";

/**
 * /api/v1/storage — where the active tenant's chunk store lives.
 *
 * Everything requires the tenant_admin role (or a provider admin). Local
 * targets are paths on the server, so creating, changing, promoting or removing
 * one additionally requires a provider admin (enforced in the service).
 *
 *   GET    /usage                            logical vs physical bytes, 30/90-day growth, daily series
 *   GET    /targets                          targets, installation default, whether the tenant holds data
 *   POST   /targets                          create (local | s3), primary or copy
 *   POST   /targets/probe                    test settings from the form (nothing saved)
 *   POST   /installation-default/test        test the installation default (not recorded; it has no row)
 *   GET    /targets/:id                      detail
 *   PATCH  /targets/:id                      name, addressing, credentials
 *   DELETE /targets/:id                      remove the target (its data stays where it is)
 *   POST   /targets/:id/test                 write/read/list/delete probe + Object Lock detection, recorded
 *   POST   /targets/:id/completeness         does this copy hold everything the primary holds?
 *   POST   /targets/:id/promote              make this copy the primary
 *   POST   /targets/:id/migration/cancel     cancel the storage migration replacing the primary with :id
 *   POST   /targets/:id/migration/retry      re-queue a failed "move" replacing the primary with :id
 *
 * Creating a target with role "primary" and a `migrationMode` while the
 * tenant already has one starts a storage migration instead of an instant
 * create (docs/STORAGE.md, "Replace the primary"); its progress then shows on
 * both targets' `migration` field in every response above.
 */

export interface StorageRoutesDeps {
  db: Database;
  /** Authenticates and admits tenant administrators (or a provider admin) only. */
  requireAdmin: MiddlewareHandler<TenantEnv>;
}

function actorOf(c: Context<TenantEnv>): Actor {
  const user = c.get("user");
  return {
    id: user.id,
    email: user.email,
    ip: clientIp(c),
    isProviderAdmin: c.get("role") === "provider_admin",
  };
}

function targetId(c: Context<TenantEnv>): string {
  return parseOrProblem(targetIdParamSchema, c.req.param()).id;
}

/**
 * Build the storage routes against injected dependencies, same style as
 * schedules/dashboard: production wires the real `db` and `requireTenant`
 * once below (`storageRoutes`), a test wires its own scratch database and a
 * stand-in for `requireAdmin` instead, so the role gate itself (not just
 * `service.ts`'s own rules) is what a Postgres-suite test exercises.
 */
export function buildStorageRoutes(deps: StorageRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();

  routes.get("/usage", deps.requireAdmin, async (c) => {
    return c.json(await storageUsage(deps.db, c.get("tenantId")));
  });

  routes.get("/targets", deps.requireAdmin, async (c) => {
    return c.json(await listTargets(deps.db, c.get("tenantId"), actorOf(c)));
  });

  routes.post("/targets", deps.requireAdmin, async (c) => {
    const input = await parseJsonBody(c.req, createStorageTargetSchema);
    return c.json(await createTarget(deps.db, c.get("tenantId"), input, actorOf(c)), 201);
  });

  routes.post("/targets/probe", deps.requireAdmin, async (c) => {
    const input = await parseJsonBody(c.req, probeStorageSchema);
    return c.json(await probeSettings(deps.db, c.get("tenantId"), input, actorOf(c)));
  });

  routes.post("/installation-default/test", deps.requireAdmin, async (c) => {
    return c.json(await testInstallationDefault(deps.db, c.get("tenantId"), actorOf(c)));
  });

  routes.get("/targets/:id", deps.requireAdmin, async (c) => {
    return c.json(await getTarget(deps.db, c.get("tenantId"), targetId(c), actorOf(c)));
  });

  routes.patch("/targets/:id", deps.requireAdmin, async (c) => {
    const patch = await parseJsonBody(c.req, updateStorageTargetSchema);
    return c.json(await updateTarget(deps.db, c.get("tenantId"), targetId(c), patch, actorOf(c)));
  });

  routes.delete("/targets/:id", deps.requireAdmin, async (c) => {
    await deleteTarget(deps.db, c.get("tenantId"), targetId(c), actorOf(c));
    return c.body(null, 204);
  });

  routes.post("/targets/:id/test", deps.requireAdmin, async (c) => {
    return c.json(await testTarget(deps.db, c.get("tenantId"), targetId(c), actorOf(c)));
  });

  routes.post("/targets/:id/completeness", deps.requireAdmin, async (c) => {
    return c.json(await checkCompleteness(deps.db, c.get("tenantId"), targetId(c), actorOf(c)));
  });

  routes.post("/targets/:id/promote", deps.requireAdmin, async (c) => {
    return c.json(await promoteTarget(deps.db, c.get("tenantId"), targetId(c), actorOf(c)));
  });

  routes.post("/targets/:id/migration/cancel", deps.requireAdmin, async (c) => {
    const id = parseOrProblem(migrationIdParamSchema, c.req.param()).id;
    return c.json(await cancelMigration(deps.db, c.get("tenantId"), id, actorOf(c)));
  });

  routes.post("/targets/:id/migration/retry", deps.requireAdmin, async (c) => {
    const id = parseOrProblem(migrationIdParamSchema, c.req.param()).id;
    return c.json(await retryMigration(deps.db, c.get("tenantId"), id, actorOf(c)));
  });

  return routes;
}

export const storageRoutes = buildStorageRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
});
