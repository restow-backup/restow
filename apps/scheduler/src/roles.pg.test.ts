// The scheduler on the database roles it runs on in production: the due scan
// on the installation role (BYPASSRLS), every write for a tenant on the
// application role (subject to Row Level Security) inside a pinned
// transaction, and pg-boss owning its schema as the installation role while
// the application role enqueues into it.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser
// (roles are cluster-wide: uniquely named ones are created and dropped again);
// skipped otherwise.

import { randomBytes } from "node:crypto";
import { type RoleLogin, assertDatabaseRoles, createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_QUEUES, pgBossQueueOptions } from "./queues.js";
import { ReportRuleStore } from "./reports.js";
import { SchedulerLoop } from "./scheduler.js";
import { ScheduleStore } from "./store.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const TEST_DB = `restow_scheduler_roles_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_sched_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_sched_provider_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};

function urlFor(base: string, login?: RoleLogin): string {
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  if (login) {
    url.username = login.name;
    url.password = login.password;
  }
  return url.toString();
}

describe.skipIf(!adminUrl)("scheduler on the provisioned database roles", () => {
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let provider: ReturnType<typeof createDb>;
  let boss: PgBoss;
  let tenantId: string;

  beforeAll(async () => {
    const base = adminUrl as string;
    const admin = createDb(base);
    try {
      await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.$client.end();
    }
    await runMigrations(urlFor(base), {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });
    owner = createDb(urlFor(base));
    app = createDb(urlFor(base, tenantLogin));
    provider = createDb(urlFor(base, installationLogin));
    // The forced DROP DATABASE in afterAll waits for these connections to close
    // (testing/database.ts); one it still terminates surfaces as an "error"
    // event on its ended pool (for pg-boss, on the PgBoss instance) and would
    // fail the run although every test passed. Only that termination is
    // ignored; any other error is rethrown, and a failing query still rejects
    // its own promise.
    for (const db of [owner, app, provider]) {
      db.$client.on("error", ignoreTerminatedConnection);
    }

    // pg-boss creates its schema and the queue partitions as the installation role.
    boss = new PgBoss({
      connectionString: urlFor(base, installationLogin),
      schedule: false,
      supervise: false,
    });
    boss.on("error", ignoreTerminatedConnection);
    await boss.start();
    for (const queue of JOB_QUEUES) {
      await boss.createQueue(queue, pgBossQueueOptions(queue));
    }

    const { rows: providerRows } = await owner.$client.query<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const { rows: tenantRows } = await owner.$client.query<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'roles', 'roles') RETURNING id",
      [providerRows[0]?.id],
    );
    tenantId = tenantRows[0]?.id ?? "";
    const { rows: sourceRows } = await owner.$client.query<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'm365', 'M365', 'active') RETURNING id",
      [tenantId],
    );
    await owner.$client.query(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, status)
       VALUES ($1, $2, 'mailbox', 'a@example.test', 'active')`,
      [tenantId, sourceRows[0]?.id],
    );
    await owner.$client.query(
      "INSERT INTO schedules (tenant_id, kind, interval_minutes) VALUES ($1, 'backup', 60)",
      [tenantId],
    );
    await owner.$client.query(
      `INSERT INTO report_rules (tenant_id, name, trigger, cron, next_run_at, sections, email_recipients)
       VALUES ($1, 'Daily', 'schedule', '0 6 * * *', '2026-03-01T06:00:00Z', ARRAY['backups'], ARRAY['it@example.test'])`,
      [tenantId],
    );
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true });
    await Promise.all([app?.$client.end(), provider?.$client.end(), owner?.$client.end()]);
    if (!adminUrl) {
      return;
    }
    await dropTestDatabase(adminUrl, TEST_DB);
    const admin = createDb(adminUrl);
    try {
      await admin.$client.query(`DROP ROLE IF EXISTS ${tenantLogin.name}`);
      await admin.$client.query(`DROP ROLE IF EXISTS ${installationLogin.name}`);
    } finally {
      await admin.$client.end();
    }
  });

  it("runs on an application role that Row Level Security binds", async () => {
    const roles = await assertDatabaseRoles({
      tenant: app.$client,
      installation: provider.$client,
    });
    expect(roles.tenant).toMatchObject({ superuser: false, bypassRls: false });
  });

  it("enqueues a due schedule through the application role", async () => {
    const loop = new SchedulerLoop({
      store: new ScheduleStore({ tenant: app.$client, installation: provider.$client }),
      reports: new ReportRuleStore({ tenant: app.$client, installation: provider.$client }),
      boss,
      tickIntervalMs: 60_000,
      batchSize: 50,
      deferMs: 3_600_000,
      isLeader: () => true,
      now: () => new Date("2026-03-01T10:00:00Z"),
      newJobId: () => "00000000-0000-4000-8000-000000000001",
    });
    expect(await loop.tick()).toEqual({
      tenantsInitialised: 0,
      schedules: 1,
      enqueued: 1,
      skipped: 0,
      deferred: 0,
      // The report rule is read on the installation role and fires on the
      // tenant role, under Row Level Security.
      reportsFired: 1,
      reportDeliveries: 1,
    });

    const { rows } = await owner.$client.query<{ pg_boss_job_id: string }>(
      "SELECT pg_boss_job_id FROM jobs WHERE tenant_id = $1",
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    const queued = await boss.getJobById("backup", rows[0]?.pg_boss_job_id ?? "");
    expect(queued?.state).toBe("created");
  });
});
