/**
 * Activating a prepared restore (activate.ts) against Postgres: a scratch database without
 * restore mode of the restore is refused and nothing is renamed; a prepared one takes the live
 * database's name, the fresh live database is set aside, and the live database then has restore
 * mode on; a second call answers that it is live already; a swap cut off after the live database
 * was renamed away is finished.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { randomBytes } from "node:crypto";
import { activateRestoreMode, createDb } from "@restow/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { ActivationRefusedError, activateRestoredDatabase, stepPool } from "./activate.js";

const suffix = randomBytes(3).toString("hex");
const LIVE = `restow_api_activate_live_${suffix}`;
const SCRATCH = `restow_api_activate_tmp_${suffix}`;

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

// Every case creates or drops whole databases and renames them (WITH (FORCE) ends sessions):
// seconds each, more than vitest's default 5 s on a busy CI runner.
describe.skipIf(!testDatabaseAdminUrl)("activating a prepared restore against Postgres", () => {
  const admin = testDatabaseAdminUrl as string;
  const liveUrl = urlFor(admin, LIVE);

  async function databases(): Promise<string[]> {
    const db = createDb(admin, { max: 1 });
    try {
      const { rows } = await db.$client.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname",
        [`restow_api_activate_%${suffix}%`],
      );
      return rows.map((row) => row.datname);
    } finally {
      await db.$client.end();
    }
  }

  async function prepareScratch(withRestoreMode: boolean): Promise<void> {
    const url = await recreateDatabase(admin, SCRATCH);
    if (withRestoreMode) {
      const db = createDb(url, { max: 1 });
      try {
        await activateRestoreMode(db.$client, {
          source: "setup",
          reason: "test",
          actor: { label: "setup (restore from a dump)" },
        });
      } finally {
        await db.$client.end();
      }
    }
  }

  async function liveRestoreMode(): Promise<string[]> {
    const db = createDb(liveUrl, { max: 1 });
    try {
      const { rows } = await db.$client.query<{ source: string }>(
        "SELECT source FROM installation_restore_mode WHERE ended_at IS NULL",
      );
      return rows.map((row) => row.source);
    } finally {
      await db.$client.end();
    }
  }

  beforeAll(async () => {
    await recreateDatabase(admin, LIVE);
  }, 120_000);

  afterAll(async () => {
    for (const name of await databases()) {
      await dropDatabase(admin, name);
    }
  }, 60_000);

  it("refuses a scratch database without restore mode of the restore and renames nothing", async () => {
    await prepareScratch(false);
    await expect(
      activateRestoredDatabase({ ownerUrl: liveUrl, scratch: SCRATCH }),
    ).rejects.toBeInstanceOf(ActivationRefusedError);
    expect(await databases()).toEqual([LIVE, SCRATCH].sort());
    expect(await liveRestoreMode()).toEqual([]);
  }, 60_000);

  it("puts a prepared restore live with restore mode on and keeps the fresh database aside", async () => {
    await prepareScratch(true);
    const result = await activateRestoredDatabase({
      ownerUrl: liveUrl,
      scratch: SCRATCH,
      now: () => new Date("2026-11-05T12:00:00Z"),
    });
    expect(result.status).toBe("activated");
    expect(result.previous).toBe(`${LIVE}_before_restore_20261105t120000z`);
    expect(await databases()).toEqual([LIVE, result.previous].sort());
    expect(await liveRestoreMode()).toEqual(["setup"]);
    // Asked again: it is live already.
    expect(await activateRestoredDatabase({ ownerUrl: liveUrl, scratch: SCRATCH })).toEqual({
      status: "already_active",
      previous: null,
    });
  }, 60_000);

  it("finishes a swap that was cut off after the live database was renamed away", async () => {
    await prepareScratch(true);
    const db = createDb(admin, { max: 1 });
    try {
      await db.$client.query(`DROP DATABASE ${LIVE} WITH (FORCE)`);
    } finally {
      await db.$client.end();
    }
    const result = await activateRestoredDatabase({ ownerUrl: liveUrl, scratch: SCRATCH });
    expect(result).toEqual({ status: "activated", previous: null });
    expect(await liveRestoreMode()).toEqual(["setup"]);
    expect(await databases()).not.toContain(SCRATCH);
  }, 60_000);

  // The swap ends the scratch database's other sessions, among them the connection `prepared`
  // may still be closing: that must not become an unhandled error that ends the process.
  it("drops a connection of its own that another session ends, without an unhandled error", async () => {
    await prepareScratch(false);
    const pool = stepPool(urlFor(admin, SCRATCH));
    try {
      await pool.query("SELECT 1");
      const db = createDb(admin, { max: 1 });
      try {
        await db.$client.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [SCRATCH],
        );
      } finally {
        await db.$client.end();
      }
      await vi.waitFor(() => expect(pool.totalCount).toBe(0));
      expect((await pool.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    } finally {
      await pool.end();
    }
  }, 60_000);
});
