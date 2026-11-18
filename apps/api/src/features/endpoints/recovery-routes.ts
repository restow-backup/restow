import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import { clientIp } from "../../lib/request.js";
import { guardBrowserRequest } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody } from "../../schemas.js";
import { SlidingWindowRateLimiter } from "../apikeys/rate-limit.js";
import { openDistributionFile } from "./distribution.js";
import { instanceUrl } from "./instance-url.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { AGENT_API_LIMIT, TEN_MINUTES_MS } from "./rate-limits.js";
import { redeemRebindInRecovery } from "./rebind.js";
import {
  type OneshotExchangeReport,
  type OneshotIsoFile,
  oneshotIso,
  recordOneshotChecks,
  reportOneshotBooted,
} from "./recovery-oneshot.js";
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
  oneshotChecksSchema,
  type RecoveryExchangeInput,
  type RecoveryOneshotExchangeInput,
  recoveryEventSchema,
  recoveryExchangeSchema,
  recoveryFinishSchema,
  recoveryLogSchema,
  recoveryOneshotBootedSchema,
  recoveryOneshotExchangeSchema,
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
 * A oneshot restore (docs/BAREMETAL-ONESHOT.md 6.2, 6.4): the command on a fresh machine exchanges
 * its code here, before the machine switches into the recovery environment.
 *
 *   POST /oneshot                                 code proof, secret hash, hardware, target, checks
 *   POST /sessions/current/oneshot/checks         the checks after the test load (while waiting)
 *   GET  /sessions/current/iso[/sums|/signature]  the offered ISO and its signed checksums (before
 *                                                 the switch; the image three times per session)
 *   POST /sessions/current/oneshot/booted         the recovery environment reports back (released)
 *
 * A session that has ended (`succeeded`, `failed`, `cancelled`) still answers `current`, so the ISO
 * learns of a cancel, and `rebind` for 15 minutes after a success; progress, log, event, release
 * and finish answer 409 `recovery-state-conflict`, audited once per session. A finish that reports
 * `succeeded` without a verification report that bears it out ends as `failed`; the answer then
 * carries `reported` and `reason` beside the `status`.
 *
 * Body limits (middleware/body-limit.ts): 64 KiB (RECOVERY_BODY_LIMIT), the log 1 MiB
 * (RECOVERY_LOG_BODY_LIMIT), the finish 320 KiB (RECOVERY_FINISH_BODY_LIMIT).
 */
export const recoveryRoutes = new Hono<{ Variables: { session: RecoverySessionAccess } }>();

/** Calls per session and 10 minutes, as for an agent. */
const sessionLimiter = new SlidingWindowRateLimiter(AGENT_API_LIMIT, TEN_MINUTES_MS);

function failureKeyOf(c: Context): string {
  return clientIp(c) ?? "unknown";
}

/** A busy repository asks the ISO to come back in half a minute, a rate limit when it says. */
function withRetryAfter(c: Context, error: unknown): never {
  if (error instanceof ProblemError && error.type === ENDPOINT_PROBLEMS.repositoryLocked) {
    c.header("retry-after", "30");
  }
  const seconds = error instanceof ProblemError ? error.extensions?.retryAfterSeconds : undefined;
  if (error instanceof ProblemError && error.status === 429 && typeof seconds === "number") {
    c.header("retry-after", String(seconds));
  }
  throw error;
}

/** The exchange of the ISO (`/sessions`) and of a oneshot command (`/oneshot`). */
async function exchangeRoute(c: Context, oneshot: boolean) {
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
  let report: OneshotExchangeReport | null = null;
  try {
    // The ISO is no browser: it sends JSON and no Origin. A request that is no exchange at all
    // (cross-site, not JSON, malformed) counts as a failed attempt like an unknown code.
    await guardBrowserRequest(c);
    if (oneshot) {
      const full: RecoveryOneshotExchangeInput = await parseJsonBody(
        c.req,
        recoveryOneshotExchangeSchema,
      );
      const { target, checks, sshKeys, ...exchange } = full;
      input = exchange;
      report = { target, checks, sshKeys };
    } else {
      input = await parseJsonBody(c.req, recoveryExchangeSchema);
    }
  } catch (error) {
    recordRecoveryFailure(key, "malformed", now);
    throw error;
  }
  try {
    const session = await exchangeRecoveryCode(
      input,
      { ip: clientIp(c), failureKey: key },
      undefined,
      0,
      report,
    );
    c.header("cache-control", "no-store");
    return c.json(session, 202);
  } catch (error) {
    return withRetryAfter(c, error);
  }
}

recoveryRoutes.post("/sessions", (c) => exchangeRoute(c, false));
recoveryRoutes.post("/oneshot", (c) => exchangeRoute(c, true));

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
  await recordProgress(c.get("session"), input, clientIp(c));
  return c.body(null, 204);
});

recoveryRoutes.post("/sessions/current/log", async (c) => {
  const input = await parseJsonBody(c.req, recoveryLogSchema);
  return c.json(await appendLog(c.get("session"), input.lines, clientIp(c)), 202);
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

recoveryRoutes.post("/sessions/current/oneshot/checks", async (c) => {
  const input = await parseJsonBody(c.req, oneshotChecksSchema);
  await recordOneshotChecks(c.get("session"), input);
  return c.body(null, 204);
});

recoveryRoutes.post("/sessions/current/oneshot/booted", async (c) => {
  const input = await parseJsonBody(c.req, recoveryOneshotBootedSchema);
  return c.json(await reportOneshotBooted(c.get("session"), input.hardware, clientIp(c)));
});

for (const [path, file] of [
  ["/sessions/current/iso", "iso"],
  ["/sessions/current/iso/sums", "sums"],
  ["/sessions/current/iso/signature", "signature"],
] as const satisfies readonly (readonly [string, OneshotIsoFile])[]) {
  recoveryRoutes.get(path, async (c) => {
    const served = await oneshotIso(c.get("session"), file, clientIp(c));
    const headers = {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${served.fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    if (served.bytes) {
      return c.body(new Uint8Array(served.bytes), 200, headers);
    }
    return new Response(
      Readable.toWeb(openDistributionFile(served.path as string)) as unknown as ReadableStream,
      { status: 200, headers: { ...headers, "content-length": String(served.size) } },
    );
  });
}

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
