import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db, providerDb } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import {
  type SessionEnv,
  type TenantEnv,
  requireProviderAdmin,
  requireTenant,
} from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  createReportRuleSchema,
  listDeliveriesQuerySchema,
  markNotificationsReadSchema,
  reportRuleParamSchema,
  updateReportRuleSchema,
} from "./schemas.js";
import {
  type ReportActor,
  createRule,
  deleteRule,
  listDeliveries,
  listInstallationNotifications,
  listNotifications,
  listRules,
  markInstallationNotificationsRead,
  markNotificationsRead,
  reportCatalog,
  testRule,
  updateRule,
} from "./service.js";

/**
 * /api/v1/reports — notification and report rules of the active tenant.
 *
 *   GET    /catalog          events, sections, periods, whether scheduled reports are available
 *   GET    /rules            the rules, with their last delivery
 *   POST   /rules            create (event rule: events; schedule rule: cadence and sections)
 *   PATCH  /rules/:id        change or switch on/off
 *   DELETE /rules/:id        delete (the delivery log keeps its rows)
 *   POST   /rules/:id/test   queue a test on every channel of the rule
 *   GET    /deliveries       the delivery log, newest first
 *
 * /api/v1/notifications — the bell.
 *
 *   GET    /                 the newest notifications of the tenant, the unread count and how
 *                            many of the unread ones are warnings or errors (`unreadAttention`)
 *   POST   /read             mark some (`ids`) or all (`all: true`) as read
 *   GET    /installation     the installation-level notifications alone, for a provider
 *                            administrator who has no tenant open (no tenant header needed)
 *   POST   /installation/read   mark those read
 *
 * Rules and the log are for tenant administrators; the bell is for every
 * member. Time-triggered rules need `reports.timed` (lib/features.ts; 403
 * otherwise).
 */

export interface ReportsRoutesDeps {
  db: Database;
  /** The installation pool: provider administrators' bell also shows installation-level notifications. */
  providerDb?: Database;
  /** Guards the installation-level bell (a provider administrator, no tenant). Needs `providerDb` as well. */
  requireProviderAdmin?: MiddlewareHandler<SessionEnv>;
  requireReader: MiddlewareHandler<TenantEnv>;
  requireAdmin: MiddlewareHandler<TenantEnv>;
  now?: () => Date;
}

function actorOf(c: Context<TenantEnv>): ReportActor {
  const user = c.get("user");
  return {
    userId: user.id,
    label: user.email,
    ip: clientIp(c),
    providerAdmin: c.get("isProviderAdmin"),
  };
}

export function buildReportsRoutes(deps: ReportsRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  const now = deps.now ?? (() => new Date());

  routes.get("/catalog", deps.requireAdmin, async (c) =>
    c.json(await reportCatalog(deps.db, { providerAdmin: c.get("isProviderAdmin") })),
  );

  routes.get("/rules", deps.requireAdmin, async (c) =>
    c.json(await listRules(deps.db, c.get("tenantId"))),
  );

  routes.post("/rules", deps.requireAdmin, async (c) => {
    const input = await parseJsonBody(c.req, createReportRuleSchema);
    return c.json(await createRule(deps.db, c.get("tenantId"), input, actorOf(c), now()), 201);
  });

  routes.patch("/rules/:id", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(reportRuleParamSchema, c.req.param());
    const patch = await parseJsonBody(c.req, updateReportRuleSchema);
    return c.json(await updateRule(deps.db, c.get("tenantId"), id, patch, actorOf(c), now()));
  });

  routes.delete("/rules/:id", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(reportRuleParamSchema, c.req.param());
    await deleteRule(deps.db, c.get("tenantId"), id, actorOf(c));
    return c.body(null, 204);
  });

  routes.post("/rules/:id/test", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(reportRuleParamSchema, c.req.param());
    return c.json(await testRule(deps.db, c.get("tenantId"), id, actorOf(c), now()), 202);
  });

  routes.get("/deliveries", deps.requireAdmin, async (c) => {
    const query = parseOrProblem(listDeliveriesQuerySchema, c.req.query());
    return c.json(await listDeliveries(deps.db, c.get("tenantId"), query));
  });

  return routes;
}

export function buildNotificationsRoutes(deps: ReportsRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  const now = deps.now ?? (() => new Date());

  // Provider administrators' bell also carries the installation-level notifications.
  const scopeOf = (c: Context<TenantEnv>) =>
    c.get("isProviderAdmin") && deps.providerDb ? { installation: deps.providerDb } : {};

  routes.get("/", deps.requireReader, async (c) =>
    c.json(await listNotifications(deps.db, c.get("tenantId"), scopeOf(c))),
  );

  routes.post("/read", deps.requireReader, async (c) => {
    const input = await parseJsonBody(c.req, markNotificationsReadSchema);
    return c.json(
      await markNotificationsRead(deps.db, c.get("tenantId"), input, now(), scopeOf(c)),
    );
  });

  // A provider administrator who has no tenant open has no tenant bell, but the installation
  // still tells them that an update is available or finished: those entries on their own.
  const { providerDb: installation, requireProviderAdmin: requireProvider } = deps;
  if (installation && requireProvider) {
    routes.get("/installation", requireProvider, async (c) =>
      c.json(await listInstallationNotifications(installation)),
    );
    routes.post("/installation/read", requireProvider, async (c) => {
      const input = await parseJsonBody(c.req, markNotificationsReadSchema);
      return c.json(await markInstallationNotificationsRead(installation, input, now()));
    });
  }

  return routes;
}

const deps: ReportsRoutesDeps = {
  db,
  providerDb,
  requireProviderAdmin,
  requireReader: requireTenant("tenant_user"),
  requireAdmin: requireTenant("tenant_admin"),
};

export const reportsRoutes = buildReportsRoutes(deps);
export const notificationsRoutes = buildNotificationsRoutes(deps);

export const REPORTS_MOUNT_PATH = "/reports";
export const NOTIFICATIONS_MOUNT_PATH = "/notifications";
