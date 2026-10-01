/**
 * Teardown of the Postgres suites of this package: dropping a suite's scratch
 * database without failing the run. Test support only: tsconfig.build.json
 * leaves this folder out of dist, so it never ships.
 *
 * A node-postgres pool's `end()` resolves before its connections have closed
 * (each idle client is sent its Terminate message, the pool does not wait for
 * the socket). A `DROP DATABASE ... WITH (FORCE)` in that moment terminates those
 * sessions, and each answers with a FATAL "terminating connection due to
 * administrator command" (57P01) that the ended pool raises as an unhandled
 * "error" event: the run fails after every test passed, more often the slower
 * the machine. runMigrations' own pool is one of them, and no listener reaches it.
 */
import pg from "pg";

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
  const admin = new pg.Pool({ connectionString: adminUrl });
  try {
    const deadline = Date.now() + DISCONNECT_WAIT_MS;
    while (Date.now() < deadline) {
      const { rows } = await admin.query<{ sessions: number }>(
        "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1",
        [name],
      );
      if ((rows[0]?.sessions ?? 0) === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, DISCONNECT_POLL_MS));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
