/**
 * Jobs a killed worker left active (reconcile.ts, #46), against the real schema and
 * pg-boss: an orphan goes back to its queue with its attempt given back and its row
 * queued; a row pg-boss no longer has active takes pg-boss' state; a job a live worker
 * may be running is left alone. Runs when RESTOW_TEST_DATABASE_URL is set.
 */
import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcileJobs } from "./reconcile.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_reconcile_test";

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return this;
  },
};

describe.skipIf(!adminUrl)("reconciling jobs a stopped worker left behind", () => {
  let boss: PgBoss;
  let db: ReturnType<typeof createDb>;
  let tenantId: string;

  const q = async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await db.$client.query<R>(text, values)).rows;

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    db.$client.on("error", ignoreTerminatedConnection);
    boss = new PgBoss({ connectionString: url.toString(), schedule: false, supervise: false });
    boss.on("error", ignoreTerminatedConnection);
    await boss.start();
    await boss.createQueue("backup", { name: "backup", retryLimit: 5, retryDelay: 60 });
    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const [tenant] = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso') RETURNING id",
      [provider?.id],
    );
    tenantId = tenant?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
    await db?.$client.end();
    await dropTestDatabase(adminUrl as string, TEST_DB);
  });

  beforeEach(async () => {
    await q("DELETE FROM jobs");
    await q("DELETE FROM service_heartbeats");
    await q("DELETE FROM pgboss.job");
  });

  /** A backup the way a worker runs it: pg-boss active, its row active, started `minutesAgo`. */
  async function running(minutesAgo: number, retryCount = 0) {
    const bossId = await boss.send("backup", { n: minutesAgo });
    const [job] = await boss.fetch("backup");
    expect(job?.id).toBe(bossId);
    await q(
      "UPDATE pgboss.job SET started_on = now() - make_interval(mins => $2), retry_count = $3 WHERE id = $1",
      [bossId, minutesAgo, retryCount],
    );
    const [row] = await q<{ id: string }>(
      `INSERT INTO jobs (tenant_id, queue, status, pg_boss_job_id, started_at, updated_at)
       VALUES ($1, 'backup', 'active', $2, now() - make_interval(mins => $3), now() - make_interval(mins => $3))
       RETURNING id`,
      [tenantId, bossId, minutesAgo],
    );
    return { bossId: bossId as string, jobId: row?.id ?? "" };
  }

  async function liveWorker(startedMinutesAgo: number) {
    await q(
      `INSERT INTO service_heartbeats (role, instance_id, version, started_at, beat_at)
       VALUES ('worker', gen_random_uuid()::text, '0.4.0', now() - make_interval(mins => $1), now())`,
      [startedMinutesAgo],
    );
  }

  const bossJob = async (id: string) =>
    (
      await q<{ state: string; retry_count: number; retry_limit: number }>(
        "SELECT state::text AS state, retry_count, retry_limit FROM pgboss.job WHERE id = $1",
        [id],
      )
    )[0];
  const jobRow = async (id: string) =>
    (
      await q<{ status: string; failure: Record<string, unknown> | null }>(
        "SELECT status::text AS status, failure FROM jobs WHERE id = $1",
        [id],
      )
    )[0];

  it("puts an orphan back into its queue with its attempt, and leaves a live worker's job alone", async () => {
    const orphan = await running(30, 2);
    const fresh = await running(1);
    // This worker started 5 minutes ago and is the only live one.
    await liveWorker(5);
    const summary = await reconcileJobs(db, {
      now: new Date(),
      selfStartedAt: new Date(),
      logger: noopLogger as never,
    });
    expect(summary).toEqual({ requeued: 1, settled: 0 });
    expect(await bossJob(orphan.bossId)).toMatchObject({
      state: "retry",
      retry_count: 1,
      retry_limit: 5,
    });
    expect(await jobRow(orphan.jobId)).toMatchObject({
      status: "queued",
      failure: {
        code: "job.interrupted",
        params: expect.objectContaining({ reason: "shutdown", final: "no" }),
      },
    });
    expect((await bossJob(fresh.bossId))?.state).toBe("active");
    expect((await jobRow(fresh.jobId))?.status).toBe("active");
    // The orphan is handed out again at once.
    const [again] = await boss.fetch("backup");
    expect(again?.id).toBe(orphan.bossId);
  });

  it("leaves everything alone while a worker that started before the job is alive", async () => {
    const job = await running(30);
    await liveWorker(60);
    const summary = await reconcileJobs(db, {
      now: new Date(),
      selfStartedAt: new Date(),
      logger: noopLogger as never,
    });
    expect(summary).toEqual({ requeued: 0, settled: 0 });
    expect((await bossJob(job.bossId))?.state).toBe("active");
  });

  it("gives a row pg-boss no longer has active the state pg-boss has", async () => {
    const retrying = await running(30);
    const lost = await running(30);
    // pg-boss expired one into a retry and failed the other for good.
    await q("UPDATE pgboss.job SET state = 'retry' WHERE id = $1", [retrying.bossId]);
    await q("UPDATE pgboss.job SET state = 'failed' WHERE id = $1", [lost.bossId]);
    await liveWorker(60);
    const summary = await reconcileJobs(db, {
      now: new Date(),
      selfStartedAt: new Date(),
      logger: noopLogger as never,
    });
    expect(summary).toEqual({ requeued: 0, settled: 2 });
    expect(await jobRow(retrying.jobId)).toMatchObject({
      status: "queued",
      failure: { code: "job.interrupted", params: expect.objectContaining({ final: "no" }) },
    });
    expect(await jobRow(lost.jobId)).toMatchObject({
      status: "failed",
      failure: { code: "job.interrupted", params: expect.objectContaining({ final: "yes" }) },
    });
  });
});
