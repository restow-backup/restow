// Scheduler against a real Postgres and a real pg-boss: due schedules turn
// into `jobs` rows plus queue entries in one transaction, singleton keys stop
// duplicates while a job is queued, and broken schedules are deferred.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
// named `restow_scheduler_test` is recreated there); skipped otherwise.

import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_QUEUES, pgBossQueueOptions } from "./queues.js";
import { SchedulerLoop } from "./scheduler.js";
import { ScheduleStore } from "./store.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_scheduler_test";

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  await runMigrations(url.toString());
  return url.toString();
}

describe.skipIf(!adminUrl)("scheduler against Postgres", () => {
  let db: ReturnType<typeof createDb>;
  let boss: PgBoss;
  let store: ScheduleStore;
  let tenantId: string;
  let suspendedTenantId: string;
  let sourceId: string;
  const objectIds: string[] = [];
  let clock = new Date("2026-03-01T10:00:00Z");
  let jobCounter = 0;

  const loop = () =>
    new SchedulerLoop({
      store,
      boss,
      tickIntervalMs: 60_000,
      batchSize: 50,
      deferMs: 3_600_000,
      isLeader: () => true,
      now: () => clock,
      newJobId: () => {
        jobCounter++;
        return `00000000-0000-4000-8000-${jobCounter.toString().padStart(12, "0")}`;
      },
    });

  beforeAll(async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    db = createDb(url);
    store = new ScheduleStore(db.$client);
    boss = new PgBoss({ connectionString: url, schedule: false, supervise: false });
    await boss.start();
    for (const queue of JOB_QUEUES) {
      await boss.createQueue(queue, pgBossQueueOptions(queue));
    }

    const { rows: providerRows } = await db.$client.query<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const providerId = providerRows[0].id;
    const insertTenant = async (slug: string, status: string) => {
      const { rows } = await db.$client.query<{ id: string }>(
        "INSERT INTO tenants (provider_id, name, slug, status) VALUES ($1, $2, $2, $3) RETURNING id",
        [providerId, slug, status],
      );
      return rows[0].id;
    };
    tenantId = await insertTenant("active-tenant", "active");
    suspendedTenantId = await insertTenant("suspended-tenant", "suspended");
    const { rows: sourceRows } = await db.$client.query<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'm365', 'M365', 'active') RETURNING id",
      [tenantId],
    );
    sourceId = sourceRows[0].id;
    for (const [externalId, status] of [
      ["a@example.test", "active"],
      ["b@example.test", "active"],
      ["c@example.test", "excluded"],
    ]) {
      const { rows } = await db.$client.query<{ id: string }>(
        `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, status)
         VALUES ($1, $2, 'mailbox', $3, $4) RETURNING id`,
        [tenantId, sourceId, externalId, status],
      );
      objectIds.push(rows[0].id);
    }
    // A schedule of a suspended tenant must never run.
    await db.$client.query(
      "INSERT INTO schedules (tenant_id, kind, interval_minutes) VALUES ($1, 'backup', 60)",
      [suspendedTenantId],
    );
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
    await db?.$client.end();
  });

  it("turns a due backup schedule into queued jobs and advances it atomically", async () => {
    const { rows } = await db.$client.query<{ id: string }>(
      "INSERT INTO schedules (tenant_id, kind, interval_minutes) VALUES ($1, 'backup', 60) RETURNING id",
      [tenantId],
    );
    const scheduleId = rows[0].id;

    const summary = await loop().tick();
    expect(summary).toEqual({
      tenantsInitialised: 0,
      schedules: 1,
      enqueued: 2,
      skipped: 0,
      deferred: 0,
      reportsFired: 0,
      reportDeliveries: 0,
    });

    const jobs = await db.$client.query<{
      id: string;
      queue: string;
      status: string;
      protected_object_id: string;
      payload: Record<string, unknown>;
      pg_boss_job_id: string;
    }>("SELECT * FROM jobs WHERE tenant_id = $1 ORDER BY created_at", [tenantId]);
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows.map((j) => j.protected_object_id).sort()).toEqual(
      objectIds.slice(0, 2).sort(),
    );
    for (const job of jobs.rows) {
      expect(job.queue).toBe("backup");
      expect(job.status).toBe("queued");
      expect(job.payload).toEqual({
        jobId: job.id,
        tenantId,
        scheduleId,
        protectedObjectId: job.protected_object_id,
      });
      const queued = await boss.getJobById("backup", job.pg_boss_job_id);
      expect(queued?.state).toBe("created");
      expect(queued?.singletonKey).toBe(`backup:${job.protected_object_id}`);
      expect(queued?.priority).toBe(40);
      expect(queued?.data).toEqual(job.payload);
    }

    const schedule = await db.$client.query<{ last_run_at: Date; next_run_at: Date }>(
      "SELECT last_run_at, next_run_at FROM schedules WHERE id = $1",
      [scheduleId],
    );
    expect(schedule.rows[0].last_run_at.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(schedule.rows[0].next_run_at.toISOString()).toBe("2026-03-01T11:00:00.000Z");

    // Not due again yet: nothing happens.
    clock = new Date("2026-03-01T10:30:00Z");
    expect(await loop().tick()).toEqual({
      tenantsInitialised: 0,
      schedules: 0,
      enqueued: 0,
      skipped: 0,
      deferred: 0,
      reportsFired: 0,
      reportDeliveries: 0,
    });

    // Due again while the previous jobs are still queued: singleton keys skip
    // them, no duplicate rows appear, the schedule still moves on.
    clock = new Date("2026-03-01T11:00:00Z");
    expect(await loop().tick()).toEqual({
      tenantsInitialised: 0,
      schedules: 1,
      enqueued: 0,
      skipped: 2,
      deferred: 0,
      reportsFired: 0,
      reportDeliveries: 0,
    });
    const count = await db.$client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM jobs WHERE tenant_id = $1",
      [tenantId],
    );
    expect(count.rows[0].n).toBe("2");
    const advanced = await db.$client.query<{ next_run_at: Date }>(
      "SELECT next_run_at FROM schedules WHERE id = $1",
      [scheduleId],
    );
    expect(advanced.rows[0].next_run_at.toISOString()).toBe("2026-03-01T12:00:00.000Z");

    await db.$client.query("UPDATE schedules SET enabled = false WHERE id = $1", [scheduleId]);
  });

  it("defers a schedule it cannot plan and leaves the tenant's other work alone", async () => {
    clock = new Date("2026-03-02T10:00:00Z");
    const { rows } = await db.$client.query<{ id: string }>(
      "INSERT INTO schedules (tenant_id, kind, cron, timezone) VALUES ($1, 'scrub', '0 3 31 2 *', 'UTC') RETURNING id",
      [tenantId],
    );
    expect(await loop().tick()).toEqual({
      tenantsInitialised: 0,
      schedules: 1,
      enqueued: 0,
      skipped: 0,
      deferred: 1,
      reportsFired: 0,
      reportDeliveries: 0,
    });
    const deferred = await db.$client.query<{ next_run_at: Date; last_run_at: Date | null }>(
      "SELECT next_run_at, last_run_at FROM schedules WHERE id = $1",
      [rows[0].id],
    );
    expect(deferred.rows[0].next_run_at.toISOString()).toBe("2026-03-02T11:00:00.000Z");
    expect(deferred.rows[0].last_run_at).toBeNull();
    await db.$client.query("UPDATE schedules SET enabled = false WHERE id = $1", [rows[0].id]);
  });

  it("plans cron schedules in their zone and tenant-wide housekeeping once", async () => {
    clock = new Date("2026-03-03T10:00:00Z");
    const { rows } = await db.$client.query<{ id: string }>(
      "INSERT INTO schedules (tenant_id, kind, cron, timezone) VALUES ($1, 'retention', '30 2 * * *', 'Europe/Berlin') RETURNING id",
      [tenantId],
    );
    expect(await loop().tick()).toEqual({
      tenantsInitialised: 0,
      schedules: 1,
      enqueued: 1,
      skipped: 0,
      deferred: 0,
      reportsFired: 0,
      reportDeliveries: 0,
    });
    const next = await db.$client.query<{ next_run_at: Date }>(
      "SELECT next_run_at FROM schedules WHERE id = $1",
      [rows[0].id],
    );
    expect(next.rows[0].next_run_at.toISOString()).toBe("2026-03-04T01:30:00.000Z");
    const retention = await db.$client.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM jobs WHERE tenant_id = $1 AND queue = 'retention'",
      [tenantId],
    );
    expect(retention.rows).toHaveLength(1);
    expect(retention.rows[0].payload).toMatchObject({ tenantId, scheduleId: rows[0].id });
  });

  it("does not tick when not the leader", async () => {
    const follower = new SchedulerLoop({
      store,
      boss,
      tickIntervalMs: 60_000,
      batchSize: 50,
      deferMs: 1000,
      isLeader: () => false,
      now: () => clock,
    });
    expect(await follower.tick()).toBeNull();
  });
});
