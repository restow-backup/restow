/**
 * Teardown of the Postgres suites: dropping a suite's scratch database without
 * failing the run.
 *
 * A node-postgres pool's `end()` resolves before its connections have closed
 * (each idle client is sent its Terminate message, the pool does not wait for
 * the socket). A `DROP DATABASE ... WITH (FORCE)` in that moment terminates those
 * sessions, and each answers with a FATAL "terminating connection due to
 * administrator command" (57P01) that the ended pool raises as an unhandled
 * "error" event: the run fails after every test passed, more often the slower
 * the machine. apps/api drops its suites' databases the same way
 * (dropDatabase in apps/api/src/features/snapshots/testing/explorer-fixture.ts).
 */
import { createDb } from "@restow/db";

/** How long a drop waits for the suite's own connections to finish closing. */
const DISCONNECT_WAIT_MS = 5_000;
const DISCONNECT_POLL_MS = 25;

/**
 * Drop `name` on the server of `adminUrl` once the suite's pools are ended:
 * wait until no session is connected to it any more (or the time is up), then
 * drop it. FORCE only ends the sessions still open after the wait, i.e.
 * connections a suite leaked.
 */
export async function dropTestDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = createDb(adminUrl);
  try {
    const deadline = Date.now() + DISCONNECT_WAIT_MS;
    while (Date.now() < deadline) {
      const { rows } = await admin.$client.query<{ sessions: number }>(
        "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1",
        [name],
      );
      if ((rows[0]?.sessions ?? 0) === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, DISCONNECT_POLL_MS));
    }
    await admin.$client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.$client.end();
  }
}

/** The messages node-postgres gives a connection whose socket the server closed. */
const TERMINATED_MESSAGES = new Set([
  "Connection terminated",
  "Connection terminated unexpectedly",
]);

/**
 * "error" listener for a pool (or a pg-boss instance) of a suite whose
 * database is dropped with FORCE: ignores exactly a terminated connection
 * (57P01 admin_shutdown, or the closed socket after it) and rethrows anything
 * else, so every other error still fails the run as without a listener.
 */
export function ignoreTerminatedConnection(error: unknown): void {
  if (error instanceof Error) {
    if ((error as { code?: unknown }).code === "57P01" || TERMINATED_MESSAGES.has(error.message)) {
      return;
    }
  }
  throw error;
}
