import { parseBasicAuthorization, secretMatchesHash } from "@restow/core";
import { type EndpointOs, type EndpointProfile, endpoints, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { db, providerDb } from "../../db.js";
import { clientIp } from "../../lib/request.js";
import { isUuid, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { SlidingWindowRateLimiter } from "../apikeys/rate-limit.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";

/**
 * Authentication of an endpoint agent (docs/AGENT.md): HTTP Basic with
 * `endpointId:agentSecret`, over HTTPS. No session, no cookie, no CSRF
 * middleware: an agent is not a browser, and a browser never holds these
 * credentials.
 *
 * The lookup happens before any tenant is pinned, so it runs on the
 * installation role like the session and API-key lookups
 * (packages/db/sql/rls.sql); everything the agent then does runs on the
 * tenant role inside a pinned transaction. A revoked endpoint, an endpoint of
 * a suspended tenant and a wrong secret are refused, and repeated failures
 * from one address are throttled.
 *
 * Rate limits (per process; Restow runs one API instance per installation):
 * the agent API 600 calls and the restic endpoint 20,000 requests per endpoint
 * and 10 minutes, and 30 failed logins per address and 10 minutes.
 */

export const ENDPOINT_REVOKED_PROBLEM = ENDPOINT_PROBLEMS.revoked;
export const AGENT_UNAUTHORIZED_PROBLEM = "urn:restow:problem:agent-unauthorized";
export const RATE_LIMITED_PROBLEM = "urn:restow:problem:rate-limited";

const TEN_MINUTES = 10 * 60 * 1000;

export const agentApiLimiter = new SlidingWindowRateLimiter(600, TEN_MINUTES);
export const resticApiLimiter = new SlidingWindowRateLimiter(20_000, TEN_MINUTES);

/** Failed logins per key in a fixed window; a key over the limit is refused without a lookup. */
export class FailureTracker {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = TEN_MINUTES,
  ) {}

  private current(key: string, now: number): { start: number; count: number } {
    const existing = this.windows.get(key);
    if (existing && now - existing.start < this.windowMs) {
      return existing;
    }
    if (this.windows.size > 10_000) {
      this.windows.clear();
    }
    const fresh = { start: now, count: 0 };
    this.windows.set(key, fresh);
    return fresh;
  }

  isBlocked(key: string, now: number): boolean {
    return this.current(key, now).count >= this.limit;
  }

  record(key: string, now: number): void {
    this.current(key, now).count += 1;
  }

  /** Milliseconds until the window of `key` ends. */
  retryAfterMs(key: string, now: number): number {
    return Math.max(1, this.current(key, now).start + this.windowMs - now);
  }
}

export const authFailures = new FailureTracker();

/** What the agent routes know about the calling endpoint. */
export interface AgentContext {
  endpointId: string;
  tenantId: string;
  hostname: string;
  profile: EndpointProfile;
  os: EndpointOs;
  ip: string | null;
}

export type AgentEnv = { Variables: { agent: AgentContext } };

const DUMMY_HASH = "0".repeat(64);

function unauthorized(): ProblemError {
  return new ProblemError(401, "Unauthorized", {
    type: AGENT_UNAUTHORIZED_PROBLEM,
    detail: "The endpoint id or agent secret is not valid.",
  });
}

function rateLimited(retryAfterMs: number): ProblemError {
  return new ProblemError(429, "Too many requests", {
    type: RATE_LIMITED_PROBLEM,
    detail: "Slow down and retry later.",
    extensions: { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
  });
}

/** `last_seen_at` is written at most this often for the restic endpoint (the agent API always writes). */
const TOUCH_RESOLUTION_MS = 60_000;
const lastTouched = new Map<string, number>();

/** Record that the endpoint was heard from and clear its "silent" alert state. */
export async function touchEndpoint(
  agent: Pick<AgentContext, "endpointId" | "tenantId" | "profile">,
  options: { force: boolean; now?: number } = { force: false },
): Promise<void> {
  const now = options.now ?? Date.now();
  const last = lastTouched.get(agent.endpointId) ?? 0;
  if (!options.force && now - last < TOUCH_RESOLUTION_MS) {
    return;
  }
  lastTouched.set(agent.endpointId, now);
  if (lastTouched.size > 10_000) {
    lastTouched.clear();
  }
  await withTenantTx(db, agent.tenantId, (tx) =>
    tx
      .update(endpoints)
      // A server that is heard from again is no longer silent; a client's overdue
      // backup stays alerted until a good backup arrives (agent-service finishRun).
      .set({
        lastSeenAt: new Date(now),
        ...(agent.profile === "server" ? { staleAlertedAt: null } : {}),
      })
      .where(eq(endpoints.id, agent.endpointId)),
  );
}

export interface AuthenticateOptions {
  limiter: SlidingWindowRateLimiter;
}

/** Verify the request's Basic credentials and return the endpoint they belong to. */
export async function authenticateAgent(
  c: Context,
  options: AuthenticateOptions,
): Promise<AgentContext> {
  const now = Date.now();
  const ip = clientIp(c);
  const failureKey = ip ?? "unknown";
  if (authFailures.isBlocked(failureKey, now)) {
    throw rateLimited(authFailures.retryAfterMs(failureKey, now));
  }
  const credentials = parseBasicAuthorization(c.req.header("authorization"));
  if (!credentials || !isUuid(credentials.username)) {
    authFailures.record(failureKey, now);
    c.header("www-authenticate", 'Basic realm="restow-agent"');
    throw unauthorized();
  }
  const [row] = await providerDb
    .select({
      id: endpoints.id,
      tenantId: endpoints.tenantId,
      hostname: endpoints.hostname,
      profile: endpoints.profile,
      os: endpoints.os,
      status: endpoints.status,
      secretHash: endpoints.secretHash,
      tenantStatus: tenants.status,
    })
    .from(endpoints)
    .innerJoin(tenants, eq(tenants.id, endpoints.tenantId))
    .where(eq(endpoints.id, credentials.username))
    .limit(1);
  // Compare against a dummy hash when the endpoint does not exist, so the
  // answer takes the same time either way.
  const matches = secretMatchesHash(credentials.password, row?.secretHash ?? DUMMY_HASH);
  if (!row || !matches) {
    authFailures.record(failureKey, now);
    c.header("www-authenticate", 'Basic realm="restow-agent"');
    throw unauthorized();
  }
  if (row.status === "revoked") {
    throw new ProblemError(401, "Endpoint revoked", {
      type: ENDPOINT_REVOKED_PROBLEM,
      detail: "This endpoint was revoked. The agent must stop backing up and can be uninstalled.",
    });
  }
  if (row.tenantStatus !== "active") {
    throw new ProblemError(403, "Tenant suspended", {
      detail: "The tenant of this endpoint is currently suspended.",
    });
  }
  const decision = options.limiter.consume(row.id, now);
  if (!decision.allowed) {
    c.header("retry-after", String(Math.ceil(decision.retryAfterMs / 1000)));
    throw rateLimited(decision.retryAfterMs);
  }
  return {
    endpointId: row.id,
    tenantId: row.tenantId,
    hostname: row.hostname,
    profile: row.profile,
    os: row.os,
    ip,
  };
}

/** Middleware for the JSON agent API: authenticates, then marks the endpoint as seen. */
export const requireAgent: MiddlewareHandler<AgentEnv> = async (c, next) => {
  const agent = await authenticateAgent(c, { limiter: agentApiLimiter });
  c.set("agent", agent);
  await touchEndpoint(agent, { force: true });
  await next();
};
