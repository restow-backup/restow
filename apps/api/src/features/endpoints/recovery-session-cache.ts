import { RECOVERY_SESSION_CACHE_MS } from "@restow/core";
import {
  acquireEndpointRepositoryLock,
  type EndpointRecoveryStatus,
  EndpointRepositoryBusyError,
  endpointRecoveries,
  endpoints,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { db, providerDb } from "../../db.js";
import { ProblemError } from "../../problem.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { READ_LOCK_WAIT_MS } from "./repository.js";

/**
 * What the ISO's requests need to know about their session (docs/BAREMETAL.md 9.6): read on the
 * installation role before the tenant is pinned (like the agent's sign-in), and kept for at most
 * five seconds, so the restic route does not ask the database for every pack it reads. A revoke,
 * cancel, release or finish in this process drops its entry at once; in another process it takes
 * effect after at most those five seconds.
 */
export interface RecoverySessionAccess {
  id: string;
  tenantId: string;
  endpointId: string;
  status: EndpointRecoveryStatus;
  secretHash: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  releasedAt: Date | null;
  finishedAt: Date | null;
  cancelRequestedAt: Date | null;
  instanceOrigin: string | null;
  tenantActive: boolean;
  endpointRemoved: boolean;
}

/** The session's state now, from the database; null when there is none. */
export async function loadRecoverySession(
  sessionId: string,
): Promise<RecoverySessionAccess | null> {
  const [row] = await providerDb
    .select({
      id: endpointRecoveries.id,
      tenantId: endpointRecoveries.tenantId,
      endpointId: endpointRecoveries.endpointId,
      status: endpointRecoveries.status,
      secretHash: endpointRecoveries.sessionSecretHash,
      expiresAt: endpointRecoveries.expiresAt,
      usedAt: endpointRecoveries.usedAt,
      releasedAt: endpointRecoveries.releasedAt,
      finishedAt: endpointRecoveries.finishedAt,
      cancelRequestedAt: endpointRecoveries.cancelRequestedAt,
      instanceOrigin: endpointRecoveries.instanceOrigin,
      tenantStatus: tenants.status,
      removedAt: endpoints.removedAt,
    })
    .from(endpointRecoveries)
    .innerJoin(tenants, eq(tenants.id, endpointRecoveries.tenantId))
    .innerJoin(endpoints, eq(endpoints.id, endpointRecoveries.endpointId))
    .where(eq(endpointRecoveries.id, sessionId))
    .limit(1);
  if (!row) {
    return null;
  }
  const { tenantStatus, removedAt, ...rest } = row;
  return { ...rest, tenantActive: tenantStatus === "active", endpointRemoved: removedAt !== null };
}

const MAX_CACHED = 1000;
const cache = new Map<string, { access: RecoverySessionAccess | null; at: number }>();

/** The session's state, at most {@link RECOVERY_SESSION_CACHE_MS} old at `now`. */
export async function cachedSessionAccess(
  sessionId: string,
  now: number,
  load: (id: string) => Promise<RecoverySessionAccess | null> = loadRecoverySession,
): Promise<RecoverySessionAccess | null> {
  const known = cache.get(sessionId);
  if (known && now - known.at < RECOVERY_SESSION_CACHE_MS && now >= known.at) {
    return known.access;
  }
  const access = await load(sessionId);
  cache.delete(sessionId);
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(sessionId, { access, at: now });
  return access;
}

/** Drop a session's cached state (it changed in this process). */
export function forgetRecoverySession(sessionId?: string): void {
  if (sessionId) {
    cache.delete(sessionId);
  } else {
    cache.clear();
  }
}

/**
 * Run `work` while holding the endpoint repository's shared maintenance lock (docs/BAREMETAL.md
 * 9.5, 9.7): a session becomes `active` only while no retention or check runs on the repository,
 * and retention looks for an active session once it holds its own lock. Busy: 503 with
 * `Retry-After: 30`, and nothing changed.
 */
export async function holdForRecovery<T>(endpointId: string, work: () => Promise<T>): Promise<T> {
  let release: () => Promise<void>;
  try {
    release = await acquireEndpointRepositoryLock(db.$client, endpointId, {
      mode: "shared",
      waitMs: READ_LOCK_WAIT_MS,
      pollMs: 200,
    });
  } catch (error) {
    if (error instanceof EndpointRepositoryBusyError) {
      throw new ProblemError(503, "Repository busy", {
        type: ENDPOINT_PROBLEMS.repositoryLocked,
        detail:
          "The server is maintaining this machine's backups (retention or a check). Try again in half a minute.",
        extensions: { retryAfterSeconds: 30 },
      });
    }
    throw error;
  }
  try {
    return await work();
  } finally {
    await release();
  }
}
