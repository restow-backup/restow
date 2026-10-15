import { asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema/index.js";
import { restartRequests, type ServiceRole } from "./schema/system.js";

/**
 * Services that need a manual restart (`restart_requests`, docs/UPDATING.md
 * "Restart required"). Any process may record that a service has to start
 * again before something takes effect; the installation administrators see
 * the open requests on the Updates tab and restart the service themselves,
 * with the command shown there or, where the updater runs, with its button.
 * Nothing restarts a service on its own.
 *
 * A request is cleared by the service it names: every process removes the
 * requests for its own role once, when it starts ({@link clearRestartRequests}),
 * so whatever was recorded until then counts as followed. No clock is
 * compared, so a container with a skewed clock cannot keep a request alive or
 * clear one that came after its start.
 */

/** A reason is a translation key (`updates:restart.reasons.<reason>`), never prose. */
export const RESTART_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The services a restart can be requested for: the three roles of the application image. */
export const RESTARTABLE_ROLES: readonly ServiceRole[] = ["api", "worker", "scheduler"];

export interface RestartRequestInput {
  service: ServiceRole;
  reason: string;
}

export interface OpenRestartRequest {
  service: ServiceRole;
  reason: string;
  requestedAt: Date;
}

type RestartDatabase = Pick<NodePgDatabase<typeof schema>, "insert" | "delete" | "select">;

/** Refused before it reaches the database: an unknown service or a reason that is not a key. */
export class InvalidRestartRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRestartRequestError";
  }
}

/**
 * Record that `service` needs a restart for `reason`, on the installation
 * pool. Recording the same reason again moves its time forward, so a request
 * made after the service started is never mistaken for one it already
 * followed.
 */
export async function requestServiceRestart(
  db: RestartDatabase,
  input: RestartRequestInput,
): Promise<void> {
  if (!RESTARTABLE_ROLES.includes(input.service)) {
    throw new InvalidRestartRequestError(`Unknown service: ${String(input.service)}`);
  }
  if (!RESTART_REASON_PATTERN.test(input.reason)) {
    throw new InvalidRestartRequestError("The reason must be a short lower-case key.");
  }
  await db
    .insert(restartRequests)
    .values({ service: input.service, reason: input.reason, requestedAt: sql`now()` })
    .onConflictDoUpdate({
      target: [restartRequests.service, restartRequests.reason],
      set: { requestedAt: sql`now()`, updatedAt: sql`now()` },
    });
}

/** The open requests, oldest first. */
export async function listRestartRequests(db: RestartDatabase): Promise<OpenRestartRequest[]> {
  return db
    .select({
      service: restartRequests.service,
      reason: restartRequests.reason,
      requestedAt: restartRequests.requestedAt,
    })
    .from(restartRequests)
    .orderBy(asc(restartRequests.requestedAt), asc(restartRequests.service));
}

/**
 * Remove the requests for `service`: the process calling this has just
 * started, so it already runs with whatever they asked for.
 * Called once at start, before the process does its own work (a request it
 * records itself later must stay). Returns how many it removed.
 */
export async function clearRestartRequests(
  db: RestartDatabase,
  service: ServiceRole,
): Promise<number> {
  const removed = await db
    .delete(restartRequests)
    .where(eq(restartRequests.service, service))
    .returning({ id: restartRequests.id });
  return removed.length;
}
