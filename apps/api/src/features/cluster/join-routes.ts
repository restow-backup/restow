import { serviceVersion } from "@restow/db";
import { Hono } from "hono";
import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { DEMO_READ_ONLY_PROBLEM } from "../../middleware/demo-guard.js";
import { guardBrowserRequest } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseOrProblem, readJsonBody } from "../../schemas.js";
import { SlidingWindowRateLimiter } from "../apikeys/rate-limit.js";
import { joinRequestSchema } from "./schemas.js";
import { formatJoinEnv, redeemJoinToken } from "./service.js";

/**
 * /api/v1/cluster-join: a new worker node joins (`install.sh --join`), without a session:
 *
 *   GET  /version   the release the node must run: { version }
 *   POST /          redeem a join token (`Authorization: Bearer rsj_...`): { nodeName, hostname,
 *                   version } -> the node's configuration (service.ts `JoinResponse`), or with
 *                   `?format=env` the node's .env as install.sh writes it (`formatJoinEnv`)
 *
 * The token authenticates the request; it is single use and short-lived. The answer carries the
 * master key and the node's database logins, so it is only ever sent over the installation's
 * TLS edge, never cached, and the join is limited per address. Refused in demo mode.
 */

/** Join attempts per address in ten minutes. */
export const JOIN_LIMIT = 10;
const TEN_MINUTES = 10 * 60_000;
export const joinLimiter = new SlidingWindowRateLimiter(JOIN_LIMIT, TEN_MINUTES);

export const clusterJoinRoutes = new Hono();

clusterJoinRoutes.get("/version", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ version: serviceVersion() });
});

clusterJoinRoutes.post("/", async (c) => {
  await guardBrowserRequest(c);
  if (config.demo.enabled) {
    throw new ProblemError(403, "Demo installation is read-only", {
      type: DEMO_READ_ONLY_PROBLEM,
      detail: "A demo installation takes no worker nodes.",
    });
  }
  const ip = clientIp(c);
  const decision = joinLimiter.consume(ip ?? "unknown", Date.now());
  if (!decision.allowed) {
    c.header("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
    throw new ProblemError(429, "Too many join attempts", {
      detail: "Try again later.",
    });
  }
  const header = c.req.header("authorization") ?? "";
  const [scheme, token] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new ProblemError(401, "Join token missing", {
      detail: "Send the join token as Authorization: Bearer rsj_...",
    });
  }
  const input = parseOrProblem(joinRequestSchema, await readJsonBody(c.req));
  const response = await redeemJoinToken(providerDb, { ...input, token, ip });
  c.header("Cache-Control", "no-store");
  // install.sh asks for the node's .env as it is (no JSON parser needed on a fresh host).
  if (c.req.query("format") === "env") {
    return c.text(formatJoinEnv(response));
  }
  return c.json(response);
});
