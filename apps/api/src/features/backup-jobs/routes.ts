import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db } from "../../db.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import { type TenantEnv, requireTenant } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { mayConfigure } from "../endpoints/routes.js";
import {
  addMembersSchema,
  candidatesQuerySchema,
  createBackupJobSchema,
  defaultsQuerySchema,
  jobParamSchema,
  listBackupJobsQuerySchema,
  memberParamSchema,
  replaceMembersSchema,
  runBackupJobSchema,
  runsQuerySchema,
  setOverridesSchema,
  updateBackupJobSchema,
} from "./schemas.js";
import type { JobActor, JobContext } from "./service-types.js";
import {
  addMembers,
  createBackupJob,
  deleteBackupJob,
  getBackupJob,
  getDefaults,
  listBackupJobs,
  listCandidates,
  listJobRuns,
  listMembers,
  removeMember,
  replaceMembers,
  runBackupJob,
  setMemberOverrides,
  updateBackupJob,
} from "./service.js";

/**
 * /api/v1/backup-jobs — what is backed up, when, where and for how long, as definitions over
 * many objects or machines (docs/ARCHITECTURE.md, "Jobs"). Not to be confused with
 * `/api/v1/jobs`, which are the runs.
 *
 *   GET    /                         the tenant's jobs with scope, schedule, last and next run, restore checks
 *   GET    /defaults?kind=           the recommended schedule, repository and choices of a new job
 *   GET    /candidates?kind=&q=      objects or machines a job can take, with the job each is in
 *   POST   /                         create (scope, schedule, settings, members with overrides)
 *   GET    /:id                      one job
 *   PATCH  /:id                      name, schedule, restore check, retention, settings, on/off
 *   DELETE /:id                      delete (the objects stop being backed up on a schedule)
 *   GET    /:id/members              the scope, with each member's overrides and state
 *   PUT    /:id/members              replace the scope
 *   POST   /:id/members              add members
 *   PATCH  /:id/members/:targetId    set one member's overrides (an empty object clears them)
 *   DELETE /:id/members/:targetId    take one member out
 *   POST   /:id/run                  back up now: the whole job or the chosen members
 *   GET    /:id/runs                 the latest runs of the job's scope
 *
 * Tenant administrators of the tenant and provider admins from the technician role on may run a
 * job, from the administrator role on change one (middleware/session.ts, lib/provider-access.ts);
 * everybody else who may read sees hook texts masked. Setting or changing a hook (it runs as
 * root on a machine) needs a recent sign-in on top (lib/recent-sign-in.ts). Every change is
 * audited in the same transaction. Invalid input is a 422 problem that names the field
 * (`field`, `issues[0].path`); a member that is in another job is a 409 that lists them.
 */

export interface BackupJobsRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
  /** Injectable clock (tests pin it). */
  now?: () => Date;
}

function actorOf(c: Context<TenantEnv>): JobActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

/** An optional JSON body: none (or an empty one) counts as `{}`, a malformed one fails validation. */
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

export function buildBackupJobsRoutes(deps: BackupJobsRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();
  const now = deps.now ?? (() => new Date());
  const admin = deps.requireAdmin;

  const contextOf = (c: Context<TenantEnv>): JobContext => ({
    now: now(),
    confirmHookChange: () => assertRecentSignIn(c.get("auth").session),
  });
  const optionsOf = (c: Context<TenantEnv>) => ({ revealHooks: mayConfigure(c) });

  routes.get("/", admin, async (c) => {
    const query = parseOrProblem(listBackupJobsQuerySchema, c.req.query());
    return c.json(await listBackupJobs(deps.db, c.get("tenantId"), query, optionsOf(c), now()));
  });

  // Static paths before `/:id`, so they are never read as a job id.
  routes.get("/defaults", admin, async (c) => {
    const { kind } = parseOrProblem(defaultsQuerySchema, c.req.query());
    return c.json(await getDefaults(deps.db, c.get("tenantId"), kind));
  });

  routes.get("/candidates", admin, async (c) => {
    const query = parseOrProblem(candidatesQuerySchema, c.req.query());
    return c.json(await listCandidates(deps.db, c.get("tenantId"), query));
  });

  routes.post("/", admin, async (c) => {
    const input = await parseJsonBody(c.req, createBackupJobSchema);
    return c.json(
      await createBackupJob(
        deps.db,
        c.get("tenantId"),
        input,
        actorOf(c),
        contextOf(c),
        optionsOf(c),
      ),
      201,
    );
  });

  routes.get("/:id", admin, async (c) => {
    const { id } = parseOrProblem(jobParamSchema, c.req.param());
    return c.json(await getBackupJob(deps.db, c.get("tenantId"), id, optionsOf(c), now()));
  });

  routes.patch("/:id", admin, async (c) => {
    const { id } = parseOrProblem(jobParamSchema, c.req.param());
    const patch = await parseJsonBody(c.req, updateBackupJobSchema);
    return c.json(
      await updateBackupJob(
        deps.db,
        c.get("tenantId"),
        id,
        patch,
        actorOf(c),
        contextOf(c),
        optionsOf(c),
      ),
    );
  });

  routes.delete("/:id", admin, async (c) => {
    const { id } = parseOrProblem(jobParamSchema, c.req.param());
    await deleteBackupJob(deps.db, c.get("tenantId"), id, actorOf(c));
    return c.body(null, 204);
  });

  routes.get("/:id/members", admin, async (c) => {
    const { id } = parseOrProblem(jobParamSchema, c.req.param());
    return c.json(await listMembers(deps.db, c.get("tenantId"), id, optionsOf(c), now()));
  });

  routes.put("/:id/members", admin, async (c) => {
    const { id } = parseOrProblem(jobParamSchema, c.req.param());
    const input = await parseJsonBody(c.req, replaceMembersSchema);
    return c.json(
      await replaceMembers(
        deps.db,
        c.get("tenantId"),
        id,
        input,
        actorOf(c),
        contextOf(c),
        optionsOf(c),
      ),
    );
  });

  routes.post("/:id/members", admin, async (c) => {
    const { id } = parseOrProblem(jobParamSchema, c.req.param());
    const input = await parseJsonBody(c.req, addMembersSchema);
    return c.json(
      await addMembers(
        deps.db,
        c.get("tenantId"),
        id,
        input,
        actorOf(c),
        contextOf(c),
        optionsOf(c),
      ),
    );
  });

  routes.patch("/:id/members/:targetId", admin, async (c) => {
    const { id, targetId } = parseOrProblem(memberParamSchema, c.req.param());
    const input = await parseJsonBody(c.req, setOverridesSchema);
    return c.json(
      await setMemberOverrides(
        deps.db,
        c.get("tenantId"),
        id,
        targetId,
        input,
        actorOf(c),
        contextOf(c),
        optionsOf(c),
      ),
    );
  });

  routes.delete("/:id/members/:targetId", admin, async (c) => {
    const { id, targetId } = parseOrProblem(memberParamSchema, c.req.param());
    return c.json(
      await removeMember(deps.db, c.get("tenantId"), id, targetId, actorOf(c), optionsOf(c), now()),
    );
  });

  routes.post("/:id/run", admin, async (c) => {
    const { id } = parseOrProblem(jobParamSchema, c.req.param());
    const input = parseOrProblem(runBackupJobSchema, await optionalBody(c));
    return c.json(
      await runBackupJob(deps.db, c.get("tenantId"), id, input, actorOf(c), now()),
      202,
    );
  });

  routes.get("/:id/runs", admin, async (c) => {
    const { id } = parseOrProblem(jobParamSchema, c.req.param());
    const { limit } = parseOrProblem(runsQuerySchema, c.req.query());
    return c.json(await listJobRuns(deps.db, c.get("tenantId"), id, limit));
  });

  return routes;
}

export const backupJobsRoutes = buildBackupJobsRoutes({
  db,
  requireAdmin: requireTenant("tenant_admin"),
});
