import { type Context, Hono } from "hono";
import { clientIp } from "../../lib/request.js";
import { guardBrowserRequest } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody } from "../../schemas.js";
import { SlidingWindowRateLimiter } from "../apikeys/rate-limit.js";
import { instanceUrl } from "./instance-url.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { AGENT_API_LIMIT, TEN_MINUTES_MS } from "./rate-limits.js";
import { redeemRebindInRecovery } from "./rebind.js";
import {
  appendLog,
  assertRebindAllowed,
  authenticateRecoverySession,
  currentState,
  exchangeRecoveryCode,
  finishSession,
  issueCredentials,
  recordEvent,
  recordProgress,
  recordRecoveryFailure,
  recoveryFailures,
  releaseSession,
  sshKeysOf,
} from "./recovery-service.js";
import type { RecoverySessionAccess } from "./recovery-session-cache.js";
import {
  type RecoveryExchangeInput,
  recoveryEventSchema,
  recoveryExchangeSchema,
  recoveryFinishSchema,
  recoveryLogSchema,
  recoveryProgressSchema,
  recoveryRebindSchema,
} from "./schemas.js";

/**
 * /agent/v1/recovery: the API of the recovery ISO (docs/BAREMETAL.md 9.3 to 9.8, 10.19). Mounted
 * ahead of the agent API (app.ts), whose agent sign-in would otherwise catch it. The exchange has
 * no credentials but the code proof in its body (and the browser request guard, which the ISO
 * always passes); everything else authenticates with HTTP Basic `<sessionId>:<sessionSecret>`.
 * Every answer that carries a secret is `cache-control: no-store`.
 *
 *   POST /sessions                        code proof, session secret hash, hardware -> session (202)
 *   GET  /sessions/current                state, expiry, cancel requested, released
 *   GET  /sessions/current/credentials    repository URL and password, snapshots, sizes (active only)
 *   GET  /sessions/current/ssh-keys       public keys the admin put in for remote access
 *   POST /sessions/current/progress       phase and counters (every 5 s)
 *   POST /sessions/current/log            up to 200 lines (2 MiB per session)
 *   POST /sessions/current/event          remote access switched on, a key file made anew
 *   POST /sessions/current/release        the end of the repository access (finishing)
 *   POST /sessions/current/finish         succeeded, failed or cancelled, with the verification
 *   POST /sessions/current/rebind         a rebind token of the machine -> the agent's state (201)
 *
 * Body limits (middleware/body-limit.ts): 64 KiB, the log 512 KiB, the finish 256 KiB.
 */
export const recoveryRoutes = new Hono<{ Variables: { session: RecoverySessionAccess } }>();

/** Calls per session and 10 minutes, as for an agent. */
const sessionLimiter = new SlidingWindowRateLimiter(AGENT_API_LIMIT, TEN_MINUTES_MS);

function failureKeyOf(c: Context): string {
  return clientIp(c) ?? "unknown";
}

/** A busy repository asks the ISO to come back in half a minute. */
function withRetryAfter(c: Context, error: unknown): never {
  if (error instanceof ProblemError && error.type === ENDPOINT_PROBLEMS.repositoryLocked) {
    c.header("retry-after", "30");
  }
  throw error;
}

recoveryRoutes.post("/sessions", async (c) => {
  const key = failureKeyOf(c);
  const now = Date.now();
  if (recoveryFailures.isBlocked(key, now)) {
    c.header("retry-after", String(Math.ceil(recoveryFailures.retryAfterMs(key, now) / 1000)));
    throw new ProblemError(429, "Too many requests", {
      type: "urn:restow:problem:rate-limited",
      detail: "Too many failed recovery code exchanges from this address. Try again later.",
    });
  }
  let input: RecoveryExchangeInput;
  try {
    // The ISO is no browser: it sends JSON and no Origin. A request that is no exchange at all
    // (cross-site, not JSON, malformed) counts as a failed attempt like an unknown code.
    await guardBrowserRequest(c);
    input = await parseJsonBody(c.req, recoveryExchangeSchema);
  } catch (error) {
    recordRecoveryFailure(key, "malformed", now);
    throw error;
  }
  try {
    const session = await exchangeRecoveryCode(input, { ip: clientIp(c), failureKey: key });
    c.header("cache-control", "no-store");
    return c.json(session, 202);
  } catch (error) {
    return withRetryAfter(c, error);
  }
});

recoveryRoutes.use("/sessions/current", async (c, next) => sessionAuth(c, next));
recoveryRoutes.use("/sessions/current/*", async (c, next) => sessionAuth(c, next));

async function sessionAuth(
  c: Context<{ Variables: { session: RecoverySessionAccess } }>,
  next: () => Promise<void>,
): Promise<void> {
  const now = Date.now();
  const session = await authenticateRecoverySession(c, failureKeyOf(c), now);
  const decision = sessionLimiter.consume(session.id, now);
  if (!decision.allowed) {
    c.header("retry-after", String(Math.ceil(decision.retryAfterMs / 1000)));
    throw new ProblemError(429, "Too many requests", {
      type: "urn:restow:problem:rate-limited",
      detail: "Slow down and retry later.",
    });
  }
  c.set("session", session);
  await next();
}

recoveryRoutes.get("/sessions/current", (c) => {
  c.header("cache-control", "no-store");
  return c.json(currentState(c.get("session")));
});

recoveryRoutes.get("/sessions/current/credentials", async (c) => {
  const credentials = await issueCredentials(c.get("session"), clientIp(c));
  c.header("cache-control", "no-store");
  return c.json(credentials);
});

recoveryRoutes.get("/sessions/current/ssh-keys", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await sshKeysOf(c.get("session")));
});

recoveryRoutes.post("/sessions/current/progress", async (c) => {
  const input = await parseJsonBody(c.req, recoveryProgressSchema);
  await recordProgress(c.get("session"), input);
  return c.body(null, 204);
});

recoveryRoutes.post("/sessions/current/log", async (c) => {
  const input = await parseJsonBody(c.req, recoveryLogSchema);
  return c.json(await appendLog(c.get("session"), input.lines), 202);
});

recoveryRoutes.post("/sessions/current/event", async (c) => {
  const input = await parseJsonBody(c.req, recoveryEventSchema);
  await recordEvent(c.get("session"), input, clientIp(c));
  return c.body(null, 204);
});

recoveryRoutes.post("/sessions/current/release", async (c) => {
  return c.json(await releaseSession(c.get("session"), clientIp(c)));
});

recoveryRoutes.post("/sessions/current/finish", async (c) => {
  const input = await parseJsonBody(c.req, recoveryFinishSchema);
  return c.json(await finishSession(c.get("session"), input, clientIp(c)));
});

recoveryRoutes.post("/sessions/current/rebind", async (c) => {
  const session = c.get("session");
  assertRebindAllowed(session, Date.now());
  const input = await parseJsonBody(c.req, recoveryRebindSchema);
  const instance = await instanceUrl(c);
  if (!instance.url) {
    throw new ProblemError(503, "Instance address unknown", {
      type: ENDPOINT_PROBLEMS.instanceUnknown,
      detail: "The public address of this installation is not configured.",
    });
  }
  const result = await redeemRebindInRecovery(session, input, {
    ip: clientIp(c),
    instanceUrl: instance.url,
  });
  c.header("cache-control", "no-store");
  return c.json(result, 201);
});
