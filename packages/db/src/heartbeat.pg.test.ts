/**
 * The service heartbeat against a real schema (docs/ARCHITECTURE.md, Health): the
 * store upserts and removes its row, the status read counts only beats younger
 * than the freshness window on the database clock, and either role of the
 * application and the installation pool can write and read it.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (roles are cluster-wide; the suite creates uniquely named ones and
 * drops them again). Without it the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_FRESH_MS,
  ServiceHeartbeatReporter,
  heartbeatStore,
  readServiceStatuses,
} from "./heartbeat.js";
import { createDb } from "./index.js";
import { runMigrations } from "./migrate.js";
import type { RoleLogin } from "./roles.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const DATABASE = `restow_db_heartbeat_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_hb_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_hb_provider_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};

function urlFor(base: string, database: string, login?: RoleLogin): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (login) {
    url.username = login.name;
    url.password = login.password;
  }
  return url.toString();
}

describe.skipIf(!adminUrl)("service heartbeats", () => {
  let owner: pg.Pool;
  let tenantDb: ReturnType<typeof createDb>;
  let installationDb: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const base = adminUrl as string;
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    const ownerUrl = urlFor(base, DATABASE);
    owner = new pg.Pool({ connectionString: ownerUrl });
    await runMigrations(ownerUrl, {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });
    tenantDb = createDb(urlFor(base, DATABASE, tenantLogin));
    installationDb = createDb(urlFor(base, DATABASE, installationLogin));
  });

  afterAll(async () => {
    await Promise.all([tenantDb?.$client.end(), installationDb?.$client.end()]);
    await owner?.end();
    await dropTestDatabase(adminUrl as string, DATABASE);
    const admin = new pg.Pool({ connectionString: adminUrl as string });
    try {
      await admin.query(`DROP ROLE IF EXISTS ${tenantLogin.name}`);
      await admin.query(`DROP ROLE IF EXISTS ${installationLogin.name}`);
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    await owner.query("DELETE FROM service_heartbeats");
  });

  /** A row as a process of `role` would have left it `ageSeconds` ago. */
  async function seed(role: "api" | "worker" | "scheduler", ageSeconds: number, id: string = role) {
    await owner.query(
      `INSERT INTO service_heartbeats (role, instance_id, version, started_at, beat_at)
       VALUES ($1, $2, '0.1.0', now() - interval '1 day', now() - $3 * interval '1 second')`,
      [role, `${id}-${ageSeconds}`, ageSeconds],
    );
  }

  it("reports a role as ok while its last beat is younger than two minutes", async () => {
    await seed("worker", 5);
    await seed("scheduler", HEARTBEAT_FRESH_MS / 1000 - 10);
    expect(await readServiceStatuses(tenantDb)).toEqual({ worker: "ok", scheduler: "ok" });
  });

  it("reports a role as missing when it never beat or its last beat is older than two minutes", async () => {
    expect(await readServiceStatuses(tenantDb)).toEqual({
      worker: "missing",
      scheduler: "missing",
    });
    await seed("worker", 5);
    await seed("scheduler", HEARTBEAT_FRESH_MS / 1000 + 10);
    expect(await readServiceStatuses(tenantDb)).toEqual({ worker: "ok", scheduler: "missing" });
  });

  it("does not take the api's own beat for a worker or a scheduler", async () => {
    await seed("api", 1);
    expect(await readServiceStatuses(tenantDb)).toEqual({
      worker: "missing",
      scheduler: "missing",
    });
  });

  it("counts any instance of a role, so a stale replica does not hide a live one", async () => {
    await seed("scheduler", 600, "scheduler-a");
    await seed("scheduler", 3, "scheduler-b");
    expect((await readServiceStatuses(tenantDb)).scheduler).toBe("ok");
  });

  it("writes a row with role, instance, version, host, start and state, and refreshes it in place", async () => {
    const beat = new ServiceHeartbeatReporter({
      store: heartbeatStore(tenantDb),
      role: "worker",
      instanceId: "worker-pg-test",
      version: "0.1.0",
      hostname: "restow-worker-1",
      details: () => ({ state: "running", queues: ["backup", "restore"] }),
      now: () => new Date("2026-09-30T10:00:00Z"),
    });
    await beat.start();
    await owner.query(
      "UPDATE service_heartbeats SET beat_at = now() - interval '10 minutes' WHERE instance_id = 'worker-pg-test'",
    );
    expect((await readServiceStatuses(tenantDb)).worker).toBe("missing");

    await beat.beat();
    const { rows } = await owner.query(
      `SELECT role, instance_id, version, hostname, started_at, details,
              beat_at > now() - interval '1 minute' AS fresh
         FROM service_heartbeats`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "worker",
      instance_id: "worker-pg-test",
      version: "0.1.0",
      hostname: "restow-worker-1",
      details: { state: "running", queues: ["backup", "restore"] },
      fresh: true,
    });
    expect(new Date(rows[0].started_at).toISOString()).toBe("2026-09-30T10:00:00.000Z");
    expect((await readServiceStatuses(tenantDb)).worker).toBe("ok");

    await beat.stop();
    const after = await owner.query("SELECT 1 FROM service_heartbeats");
    expect(after.rowCount).toBe(0);
    expect((await readServiceStatuses(tenantDb)).worker).toBe("missing");
  });

  it("works on the installation pool as well and sweeps rows of instances dead for a day", async () => {
    await seed("worker", 2 * 24 * 3600, "worker-gone");
    await seed("worker", 600, "worker-recent");
    const beat = new ServiceHeartbeatReporter({
      store: heartbeatStore(installationDb),
      role: "scheduler",
      details: () => ({ state: "leader", leader: true }),
    });
    await beat.start();
    const { rows } = await owner.query<{ role: string; instance_id: string }>(
      "SELECT role, instance_id FROM service_heartbeats ORDER BY instance_id",
    );
    expect(rows.map((row) => row.instance_id).filter((id) => id.startsWith("worker"))).toEqual([
      "worker-recent-600",
    ]);
    expect(rows.filter((row) => row.role === "scheduler")).toHaveLength(1);
    expect((await readServiceStatuses(installationDb)).scheduler).toBe("ok");
    await beat.stop();
  });

  it("stores a host name only, never an IP address", async () => {
    const beat = new ServiceHeartbeatReporter({
      store: heartbeatStore(tenantDb),
      role: "worker",
      hostname: "10.0.0.7",
      details: () => ({ state: "running" }),
    });
    await beat.start();
    const { rows } = await owner.query<{ hostname: string | null }>(
      "SELECT hostname FROM service_heartbeats",
    );
    expect(rows).toEqual([{ hostname: null }]);
    await beat.stop();
  });
});
