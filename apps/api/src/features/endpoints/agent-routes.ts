import { Hono } from "hono";
import { clientIp } from "../../lib/request.js";
import { guardBrowserRequest } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { type AgentEnv, authFailures, requireAgent } from "./agent-auth.js";
import {
  agentConfig,
  agentUpdate,
  enrollEndpoint,
  enrollFailures,
  finishRun,
  heartbeat,
  reportProgress,
  startRun,
} from "./agent-service.js";
import { instanceUrl } from "./instance-url.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import {
  type EnrollInput,
  enrollSchema,
  finishRunSchema,
  heartbeatSchema,
  progressSchema,
  runIdParamSchema,
  startRunSchema,
} from "./schemas.js";

/**
 * /agent/v1: the API of the endpoint agent (docs/AGENT.md). JSON over HTTPS,
 * errors as `application/problem+json`. Enrollment authenticates with the
 * one-time token in its body; everything else with HTTP Basic
 * `endpointId:agentSecret`. None of it uses the session; enrollment, the one
 * route without credentials, refuses cross-site and non-JSON requests
 * (middleware/session.ts `guardBrowserRequest`), which an agent never sends.
 *
 *   POST /enroll                      token + machine facts -> id, secret, repository, config
 *   GET  /config                      the configuration to run
 *   POST /heartbeat                   state in, tasks out (every 5 minutes)
 *   POST /runs                        a backup, restore or restore test starts
 *   POST /runs/:runId/progress        progress of a running run
 *   POST /runs/:runId/finish          result, samples and log tail
 *   GET  /update                      a newer agent binary, or null
 */
export const agentRoutes = new Hono<AgentEnv>();

agentRoutes.post("/enroll", async (c) => {
  const ip = clientIp(c);
  const key = ip ?? "unknown";
  const now = Date.now();
  if (enrollFailures.isBlocked(key, now)) {
    c.header("retry-after", String(Math.ceil(enrollFailures.retryAfterMs(key, now) / 1000)));
    throw new ProblemError(429, "Too many requests", {
      type: "urn:restow:problem:rate-limited",
      detail: "Too many failed enrollments from this address. Try again later.",
    });
  }
  let input: EnrollInput;
  try {
    // An agent is no browser: it sends JSON and no Origin. A request a web
    // page sent from another site (403) or a body that is not JSON (415) is
    // refused like on the browser's routes.
    await guardBrowserRequest(c);
    input = await parseJsonBody(c.req, enrollSchema);
  } catch (error) {
    // A request that is no enrollment at all (cross-site, not JSON, malformed,
    // wrong shape, too large) counts as a failed attempt like a wrong token,
    // so junk requests run into the same limit instead of being retried
    // without end.
    enrollFailures.record(key, now);
    authFailures.record(key, now);
    throw error;
  }
  const instance = await instanceUrl(c);
  if (!instance.url) {
    throw new ProblemError(503, "Instance address unknown", {
      type: ENDPOINT_PROBLEMS.instanceUnknown,
      detail: "The public address of this installation is not configured.",
    });
  }
  try {
    const result = await enrollEndpoint(input, { ip, instanceUrl: instance.url });
    c.header("cache-control", "no-store");
    return c.json(result, 201);
  } catch (error) {
    if (error instanceof ProblemError && error.status === 401) {
      enrollFailures.record(key, now);
      authFailures.record(key, now);
    }
    throw error;
  }
});

agentRoutes.use("*", requireAgent);

agentRoutes.get("/config", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await agentConfig(c.get("agent")));
});

agentRoutes.post("/heartbeat", async (c) => {
  const input = await parseJsonBody(c.req, heartbeatSchema);
  c.header("cache-control", "no-store");
  return c.json(await heartbeat(c.get("agent"), input));
});

agentRoutes.post("/runs", async (c) => {
  const input = await parseJsonBody(c.req, startRunSchema);
  return c.json(await startRun(c.get("agent"), input), 201);
});

agentRoutes.post("/runs/:runId/progress", async (c) => {
  const { runId } = parseOrProblem(runIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, progressSchema);
  await reportProgress(c.get("agent"), runId, input);
  return c.body(null, 204);
});

agentRoutes.post("/runs/:runId/finish", async (c) => {
  const { runId } = parseOrProblem(runIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, finishRunSchema);
  return c.json(await finishRun(c.get("agent"), runId, input));
});

agentRoutes.get("/update", async (c) => {
  const instance = await instanceUrl(c);
  c.header("cache-control", "no-store");
  return c.json(await agentUpdate(c.get("agent"), instance.url));
});
