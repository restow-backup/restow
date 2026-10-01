import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  applyRecommendedSchema,
  createScheduleSchema,
  previewScheduleSchema,
  scheduleParamSchema,
  updateScheduleSchema,
} from "./schemas.js";
import {
  type ScheduleActor,
  applyRecommendedSchedules,
  createSchedule,
  deleteSchedule,
  listSchedules,
  previewSchedule,
  updateSchedule,
} from "./service.js";

/**
 * /api/v1/schedules — what runs unattended for the active tenant.
 *
 *   GET    /              schedules with next and last run and the last job; missing recommended kinds
 *   POST   /preview       the next 5 runs of { intervalMinutes | cron, timezone } (nothing saved)
 *   POST   /recommended   add the recommended schedules the tenant is missing (idempotent)
 *   POST   /              create (exactly one of intervalMinutes and cron)
 *   PATCH  /:id           change cadence, zone, scope or switch on/off
 *   DELETE /:id           delete
 *
 * Every member of the tenant may read (tenant users see the schedules
 * read-only, and another person's object by its kind only, with no job ids:
 * the object list and the jobs are for administrators); changing them
 * requires tenant_admin (or a provider admin). Every
 * change is audited in the same transaction. Invalid cadences are 422 problems
 * that name the field (`field`, `issues[0].path`).
 */

export interface SchedulesRoutesDeps {
  db: Database;
  /** Authenticates and admits anyone who may read the tenant's schedules. */
  requireReader: MiddlewareHandler<TenantEnv>;
  /** Authenticates and admits tenant administrators only. */
  requireAdmin: MiddlewareHandler<TenantEnv>;
  /** Injectable clock (tests pin it). */
  now?: () => Date;
}

function actorOf(c: Context<TenantEnv>): ScheduleActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

/** Parse an optional JSON body: none (or an empty one) counts as `{}`. */
async function optionalBody(c: Context<TenantEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function buildSchedulesRoutes(deps: SchedulesRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  const now = deps.now ?? (() => new Date());

  routes.get("/", deps.requireReader, async (c) => {
    const viewer = { role: c.get("role"), email: c.get("user").email };
    return c.json(await listSchedules(deps.db, c.get("tenantId"), viewer));
  });

  // Static paths before `/:id`, so they are never read as a schedule id.
  routes.post("/preview", deps.requireReader, async (c) => {
    const input = await parseJsonBody(c.req, previewScheduleSchema);
    return c.json(previewSchedule(input, now()));
  });

  routes.post("/recommended", deps.requireAdmin, async (c) => {
    const input = parseOrProblem(applyRecommendedSchema, await optionalBody(c));
    return c.json(
      await applyRecommendedSchedules(deps.db, c.get("tenantId"), input, actorOf(c), now()),
    );
  });

  routes.post("/", deps.requireAdmin, async (c) => {
    const input = await parseJsonBody(c.req, createScheduleSchema);
    return c.json(await createSchedule(deps.db, c.get("tenantId"), input, actorOf(c), now()), 201);
  });

  routes.patch("/:id", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(scheduleParamSchema, c.req.param());
    const patch = await parseJsonBody(c.req, updateScheduleSchema);
    return c.json(await updateSchedule(deps.db, c.get("tenantId"), id, patch, actorOf(c), now()));
  });

  routes.delete("/:id", deps.requireAdmin, async (c) => {
    const { id } = parseOrProblem(scheduleParamSchema, c.req.param());
    await deleteSchedule(deps.db, c.get("tenantId"), id, actorOf(c));
    return c.body(null, 204);
  });

  return routes;
}

export const schedulesRoutes = buildSchedulesRoutes({
  db,
  requireReader: requireTenant("tenant_user"),
  requireAdmin: requireTenant("tenant_admin"),
});
