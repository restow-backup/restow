import type { Database } from "@restow/db";
import { Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseOrProblem } from "../../schemas.js";
import { windowStart } from "../jobs/events.js";
import { streamEvents } from "../jobs/sse-transport.js";
import { createLiveStep, databaseSources } from "./live.js";
import { getRunDetail, listHistory } from "./read.js";
import { historyQuerySchema, runIdParamSchema } from "./schemas.js";

/**
 * /api/v1/history, the runs of the tenant, and /api/v1/live, the stream that keeps them current.
 *
 *   GET /history            every run, mail and agent, newest first (type, job, cursor)
 *   GET /history/:id        one run with its objects, its timeline and its restore check
 *   GET /live               server-sent events: runs, backup jobs and machines as they change
 *
 * For the web app (a session; tenant administrators, provider admins by their team role, see
 * lib/provider-access.ts). The integration API keeps its own, versioned shapes at /jobs and
 * /runs; nothing here is part of that contract, and an API key never reaches this stream (it
 * also carries the tenant's machines and job definitions, which the key's scopes do not cover).
 */

export interface HistoryRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
}

export function buildHistoryRoutes(deps: HistoryRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  const admin = deps.requireAdmin;

  routes.get("/", admin, async (c) => {
    const query = parseOrProblem(historyQuerySchema, c.req.query());
    return c.json(
      await listHistory(deps.db, c.get("tenantId"), {
        category: query.type,
        jobId: query.job,
        limit: query.limit,
        cursor: query.cursor,
      }),
    );
  });

  routes.get("/:id", admin, async (c) => {
    const { id } = parseOrProblem(runIdParamSchema, c.req.param());
    return c.json(await getRunDetail(deps.db, c.get("tenantId"), id));
  });

  return routes;
}

export function buildLiveRoutes(deps: HistoryRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  routes.get("/", deps.requireAdmin, async (c) => {
    const tenantId = c.get("tenantId");
    const step = createLiveStep(databaseSources(deps.db, tenantId, windowStart(new Date())));
    return streamEvents(c, step, { tenantId, stream: "live" }, "live event stream failed");
  });
  return routes;
}

const requireAdmin = requireTenant("tenant_admin");
export const historyRoutes = buildHistoryRoutes({ db, requireAdmin });
export const liveRoutes = buildLiveRoutes({ db, requireAdmin });
