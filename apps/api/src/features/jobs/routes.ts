import { safeErrorMessage } from "@restow/db";
import { type Context, Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { db } from "../../db.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { type JobsEnv, requireJobsAccess } from "./access.js";
import {
  JobChangeTracker,
  type StreamIo,
  type StreamStep,
  jobMessage,
  jobsMessage,
  runStreamLoop,
  singleJobStep,
  windowStart,
} from "./events.js";
import {
  eventsQuerySchema,
  jobIdParamSchema,
  listJobsQuerySchema,
  objectIdParamSchema,
  objectsQuerySchema,
  snapshotsQuerySchema,
  startBackupSchema,
} from "./schemas.js";
import {
  cancelJob,
  findJob,
  getJob,
  listBackupTargets,
  listJobs,
  listLiveJobs,
  listSnapshots,
  retryJob,
  startBackup,
} from "./service.js";

/**
 * /api/v1/jobs — the job system for the backup operator and for integrations.
 *
 * A session needs the `tenant_admin` role in the tenant (provider admins
 * qualify everywhere): jobs name every mailbox of the tenant, and starting,
 * cancelling or retrying work is administration. End users follow their own
 * restores through /api/v1/restore. API keys need the scope named per route
 * (docs/ARCHITECTURE.md, "API"); see ./access.ts.
 */

export const jobsRoutes = new Hono<JobsEnv>();

const readJobs = requireJobsAccess("jobs:read");
const readItems = requireJobsAccess("items:read");
// The published scope set has no `backup:write`; job control maps onto `restore:write`.
const controlJobs = requireJobsAccess("restore:write");

/** A sleep that ends early once `signal` fires (the client disconnected). */
function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Adapt Hono's SSE stream to the loop's transport. */
function sseIo(stream: SSEStreamingApi): StreamIo {
  const disconnected = new AbortController();
  stream.onAbort(() => disconnected.abort());
  return {
    write: (message) => stream.writeSSE({ ...message }),
    heartbeat: async () => {
      await stream.write(": keep-alive\n\n");
    },
    sleep: (ms) => sleepUnless(ms, disconnected.signal),
    gone: () => stream.aborted || stream.closed,
    now: () => Date.now(),
  };
}

/** Run a stream; a failed read is logged here (the client already got an `error` event). */
function streamJobs(
  c: Context<JobsEnv>,
  step: () => Promise<StreamStep>,
  context: Record<string, unknown>,
) {
  // Tell reverse proxies (nginx, some Caddy setups) not to buffer the stream.
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    try {
      await runStreamLoop(sseIo(stream), step);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "job event stream failed",
          ...context,
          // Never the failed query with its bound parameters.
          errorMessage: safeErrorMessage(error),
        }),
      );
    }
  });
}

// Static paths first, so they never match as a job id.

jobsRoutes.get("/", readJobs, async (c) => {
  const query = parseOrProblem(listJobsQuerySchema, c.req.query());
  return c.json(await listJobs(db, c.get("tenantId"), query));
});

/**
 * Tenant-wide live updates: a `jobs` snapshot of what is running or changed
 * in the last minute, then a `job` event for every job that changes.
 */
jobsRoutes.get("/events", readJobs, async (c) => {
  const { queue } = parseOrProblem(eventsQuerySchema, c.req.query());
  const tenantId = c.get("tenantId");
  const since = windowStart(new Date());
  const tracker = new JobChangeTracker();
  let primed = false;
  return streamJobs(
    c,
    async () => {
      const live = await listLiveJobs(db, tenantId, since, queue);
      if (!primed) {
        primed = true;
        tracker.prime(live);
        return { messages: [jobsMessage(live)], done: false };
      }
      return { messages: tracker.changes(live).map(jobMessage), done: false };
    },
    { tenantId, stream: "jobs" },
  );
});

jobsRoutes.get("/objects", readItems, async (c) => {
  const { kind } = parseOrProblem(objectsQuerySchema, c.req.query());
  return c.json({ items: await listBackupTargets(db, c.get("tenantId"), kind) });
});

jobsRoutes.get("/objects/:id/snapshots", readItems, async (c) => {
  const { id } = parseOrProblem(objectIdParamSchema, c.req.param());
  const query = parseOrProblem(snapshotsQuerySchema, c.req.query());
  return c.json(await listSnapshots(db, c.get("tenantId"), id, query));
});

/** "Backup now" for one object, or every protected object when none is named. */
jobsRoutes.post("/backup", controlJobs, async (c) => {
  const input = await parseJsonBody(c.req, startBackupSchema);
  return c.json(await startBackup(db, c.get("tenantId"), input, c.get("actor")), 202);
});

jobsRoutes.get("/:id", readJobs, async (c) => {
  const { id } = parseOrProblem(jobIdParamSchema, c.req.param());
  return c.json(await getJob(db, c.get("tenantId"), id));
});

/** Live updates of one job; ends with an `end` event once the job is finished. */
jobsRoutes.get("/:id/events", readJobs, async (c) => {
  const { id } = parseOrProblem(jobIdParamSchema, c.req.param());
  const tenantId = c.get("tenantId");
  // A missing job is a plain 404 problem, not an empty stream.
  if ((await findJob(db, tenantId, id)) === null) {
    throw new ProblemError(404, "Job not found");
  }
  const tracker = new JobChangeTracker();
  return streamJobs(c, async () => singleJobStep(tracker, id, await findJob(db, tenantId, id)), {
    tenantId,
    jobId: id,
    stream: "job",
  });
});

jobsRoutes.post("/:id/cancel", controlJobs, async (c) => {
  const { id } = parseOrProblem(jobIdParamSchema, c.req.param());
  return c.json(await cancelJob(db, c.get("tenantId"), id, c.get("actor")));
});

jobsRoutes.post("/:id/retry", controlJobs, async (c) => {
  const { id } = parseOrProblem(jobIdParamSchema, c.req.param());
  return c.json(await retryJob(db, c.get("tenantId"), id, c.get("actor")), 202);
});
