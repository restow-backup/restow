import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

import { db } from "../db.js";
import { DEMO_READ_ONLY_PROBLEM } from "../middleware/demo-guard.js";
import type { TenantEnv } from "../middleware/session.js";
import { ProblemError } from "../problem.js";
import { audit } from "./audit.js";
import { clientIp } from "./request.js";
import type { DbExecutor } from "./tenant-context.js";

/**
 * Refused actions in the audit log (`access.denied`): a signed-in user who
 * got a 403 (wrong role, tenant outside their scope, provider-only endpoint)
 * leaves a trace, so an admin can see who tried what.
 *
 * Only our own words are written: the route pattern (never the raw URL, which
 * the caller chose), the method and the problem title the API itself set.
 * Requests without a signed-in user are not recorded (nothing to attribute),
 * and neither are the public demo's read-only refusals, which every visitor
 * triggers by design.
 *
 * Throttled per user, tenant, route and reason: a client that retries in a
 * loop writes one entry per window, not one per request.
 */

export const DENIED_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED = 10_000;

export class DeniedThrottle {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs: number = DENIED_WINDOW_MS) {}

  /** Whether `key` may be recorded at `now`; records the attempt when it may. */
  allow(key: string, now: number): boolean {
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) {
      return false;
    }
    if (this.seen.size >= MAX_TRACKED) {
      // Oldest first (insertion order); dropping it only risks one extra entry.
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.delete(key);
    this.seen.set(key, now);
    return true;
  }
}

export interface DeniedEvent {
  userId: string;
  actor: string;
  tenantId: string | null;
  method: string;
  route: string;
  reason: string;
  ip: string | null;
}

/** The refusal to record for a finished request, or null when there is none to record. */
export function deniedEventOf(input: {
  error: unknown;
  user: { id: string; email: string } | undefined;
  tenantId: string | undefined;
  method: string;
  route: string;
  ip: string | null;
}): DeniedEvent | null {
  const { error, user } = input;
  if (!(error instanceof ProblemError) || error.status !== 403 || !user) {
    return null;
  }
  if (error.type === DEMO_READ_ONLY_PROBLEM) {
    return null;
  }
  return {
    userId: user.id,
    actor: user.email,
    tenantId: input.tenantId ?? null,
    method: input.method,
    route: input.route,
    reason: error.title,
    ip: input.ip,
  };
}

export type DeniedWriter = (event: DeniedEvent) => Promise<void>;

/** Append one refusal to the audit chain (the tenant's, or the installation's without one). */
export async function recordDenied(database: DbExecutor, event: DeniedEvent): Promise<void> {
  await audit(database, {
    tenantId: event.tenantId,
    action: "access.denied",
    actor: event.actor,
    actorUserId: event.userId,
    target: `${event.method} ${event.route}`,
    targetType: "route",
    ip: event.ip,
    details: { reason: event.reason },
  });
}

const writeToAuditLog: DeniedWriter = (event) => recordDenied(db, event);

/** Build the middleware; tests pass their own writer, clock and throttle. */
export function deniedAudit(
  options: { write?: DeniedWriter; throttle?: DeniedThrottle; now?: () => number } = {},
): MiddlewareHandler {
  const write = options.write ?? writeToAuditLog;
  const throttle = options.throttle ?? new DeniedThrottle();
  const now = options.now ?? Date.now;
  return async (c, next) => {
    await next();
    // Set by the session and tenant middlewares further down, when they ran;
    // undefined for every request that never reached them.
    const vars = c as unknown as Context<TenantEnv>;
    const event = deniedEventOf({
      error: c.error,
      user: vars.get("user") as { id: string; email: string } | undefined,
      tenantId: vars.get("tenantId") as string | undefined,
      method: c.req.method,
      route: safeRoutePath(c),
      ip: clientIp(c),
    });
    if (!event) {
      return;
    }
    const key = [event.userId, event.tenantId ?? "-", event.method, event.route, event.reason].join(
      "|",
    );
    if (!throttle.allow(key, now())) {
      return;
    }
    // Recording must never turn a 403 into a 500 or hold the response.
    await write(event).catch(() => undefined);
  };
}

function safeRoutePath(c: Context): string {
  try {
    return routePath(c, -1);
  } catch {
    return "unknown";
  }
}
