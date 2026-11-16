import { endpointPrefix, secretMatchesHash } from "@restow/core";
import { db } from "../../db.js";
import { DeniedThrottle } from "../../lib/denied-audit.js";
import {
  buildRunResticRoute,
  processLocalLocks,
  type RunResticResolution,
} from "../../lib/restic-run-route.js";
import { ProblemError } from "../../problem.js";
import { SlidingWindowRateLimiter } from "../apikeys/rate-limit.js";
import { auditEndpoint, ENDPOINT_AUDIT_ACTIONS, recoveryActor } from "./audit.js";
import { RECOVERY_RESTIC_PATH } from "./meta.js";
import { RECOVERY_RESTIC_LIMIT, TEN_MINUTES_MS } from "./rate-limits.js";
import { recoveryFailures } from "./recovery-service.js";
import { cachedSessionAccess } from "./recovery-session-cache.js";
import { backendHolding, tenantStorage } from "./repository.js";

/**
 * /agent/recovery/restic/:sessionId: the restic REST backend a recovery session reads its machine's
 * backups through (docs/BAREMETAL.md 9.6). HTTP Basic `<sessionId>:<sessionSecret>`, and the
 * session in the path must be the one of the credential. The principal is `reader`: restic in the
 * ISO runs with `--no-lock --no-cache`, and every write or delete is refused and audited (as
 * `principal: "recovery"`, throttled like the agent's). Only while the session is active and not
 * released, before its expiry, for an active tenant and a machine that is not removed; otherwise
 * 401 "Credential expired". The session's state is cached for at most five seconds, so a cancel or
 * release takes effect within that.
 *
 * The repository is read from whichever storage target holds it (after a storage migration the
 * old one, attached read-only). At most 120,000 requests per session and 10 minutes.
 */

const denials = new DeniedThrottle();
const locks = processLocalLocks();
const limiter = new SlidingWindowRateLimiter(RECOVERY_RESTIC_LIMIT, TEN_MINUTES_MS);

/** What a recovery credential may read; the limiter is passed in by tests. */
export async function resolveRecoveryCredential(
  credentials: { runId: string; token: string },
  sessionId: string,
  now: number,
  rate: Pick<SlidingWindowRateLimiter, "consume"> = limiter,
): Promise<RunResticResolution> {
  if (credentials.runId !== sessionId) {
    return { ok: false, reason: "invalid" };
  }
  const access = await cachedSessionAccess(sessionId, now);
  if (!access?.secretHash || !secretMatchesHash(credentials.token, access.secretHash)) {
    return { ok: false, reason: "invalid" };
  }
  if (
    access.status !== "active" ||
    access.releasedAt !== null ||
    access.expiresAt.getTime() <= now ||
    !access.tenantActive ||
    access.endpointRemoved
  ) {
    return { ok: false, reason: "expired" };
  }
  const decision = rate.consume(sessionId, now);
  if (!decision.allowed) {
    throw new ProblemError(429, "Too many requests", {
      type: "urn:restow:problem:rate-limited",
      detail: "Slow down and retry later.",
      extensions: { retryAfterSeconds: Math.ceil(decision.retryAfterMs / 1000) },
    });
  }
  const prefix = endpointPrefix(access.endpointId);
  return {
    ok: true,
    access: {
      tenantId: access.tenantId,
      runId: access.id,
      principal: "reader",
      prefix,
      storage: await backendHolding(await tenantStorage(db, access.tenantId), prefix),
    },
  };
}

/** The endpoint of a repository prefix (`endpoints/<id>/`). */
function endpointOfPrefix(prefix: string): string | null {
  return /^endpoints\/([0-9a-f-]{36})\/$/.exec(prefix)?.[1] ?? null;
}

export const recoveryResticRoutes = buildRunResticRoute({
  basePath: RECOVERY_RESTIC_PATH,
  param: "sessionId",
  realm: "restow-recovery",
  resolve: (credentials, sessionId, now) => resolveRecoveryCredential(credentials, sessionId, now),
  locks: (access) => locks(access.runId),
  failures: recoveryFailures,
  audit: (access, sessionId, denial) => {
    const endpointId = endpointOfPrefix(access.prefix);
    if (!endpointId) {
      return;
    }
    const key = `${sessionId}:${denial.action}:${denial.type}:${denial.reason}`;
    if (!denials.allow(key, Date.now())) {
      return;
    }
    void auditEndpoint(db, {
      tenantId: access.tenantId,
      actor: recoveryActor(sessionId, denial.ip),
      action: ENDPOINT_AUDIT_ACTIONS.repositoryDenied,
      endpointId,
      details: {
        principal: "recovery",
        recoveryId: sessionId,
        action: denial.action,
        type: denial.type,
        reason: denial.reason,
        method: denial.method,
      },
    }).catch(() => undefined);
  },
});
