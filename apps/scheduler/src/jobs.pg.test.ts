// Backups and restore checks planned from mail jobs, on the database roles the scheduler runs on
// in production (the application role under Row Level Security for everything of one tenant,
// the installation role for the scan across tenants): a job that is due enqueues one backup per
// object it covers with the job named in the payload, a restore check follows its own schedule,
// an object with a schedule of its own runs on its member's timer, the scope of an "all" job
// leaves the objects of other jobs alone, a schedule a job took over is no longer planned while
// one that stayed keeps running, a job changed since it was loaded is left alone, and what
// cannot be planned is deferred.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (a uniquely named
// database and roles are created and dropped again); skipped otherwise.

import { randomBytes } from "node:crypto";
import { type RoleLogin, createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandJobUnit } from "./planning.js";
import { JOB_QUEUES, pgBossQueueOptions } from "./queues.js";
import { SchedulerLoop } from "./scheduler.js";
import { ScheduleStore } from "./store.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const TEST_DB = `restow_scheduler_jobs_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_sched_jobs_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_sched_jobs_provider_${suffix}`,
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

const BERLIN = "Europe/Berlin";
const every = (minutes: number) => ({
  kind: "interval",
  intervalMinutes: minutes,
  timeZone: BERLIN,
});
const cron = (expression: string) => ({ kind: "cron", cron: expression, timeZone: BERLIN });

describe.skipIf(!adminUrl)("backup jobs planned by the scheduler", () => {
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let provider: ReturnType<typeof createDb>;
  let boss: PgBoss;
  let providerId: string;
  let clock = new Date("2026-03-04T10:00:00Z");
  let jobCounter = 0;

  const store = () => new ScheduleStore({ tenant: app.$client, installation: provider.$client });
  const loop = () =>
    new SchedulerLoop({
      store: store(),
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

  async function tenant(slug: string, status = "active"): Promise<string> {
    const { rows } = await owner.$client.query<{ id: string }>(
      `INSERT INTO tenants (provider_id, name, slug, status, backup_jobs_migrated_at)
       VALUES ($1, $2, $2, $3, now()) RETURNING id`,
      [providerId, slug, status],
    );
    return rows[0]?.id ?? "";
  }

  async function source(
    tenantId: string,
    kind: "m365" | "imap" | "import" = "m365",
  ): Promise<string> {
    const { rows } = await owner.$client.query<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, $2::source_kind, $3, 'active') RETURNING id",
      [tenantId, kind, kind],
    );
    return rows[0]?.id ?? "";
  }

  async function mailbox(
    tenantId: string,
    sourceId: string,
    name: string,
    status = "active",
  ): Promise<string> {
    const { rows } = await owner.$client.query<{ id: string }>(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, status)
       VALUES ($1, $2, 'mailbox', $3, $4) RETURNING id`,
      [tenantId, sourceId, `${name}@example.test`, status],
    );
    return rows[0]?.id ?? "";
  }

  async function job(
    tenantId: string,
    values: {
      name: string;
      scope?: "all" | "selected";
      schedule?: unknown;
      verify?: unknown;
      enabled?: boolean;
      nextRunAt?: Date | null;
      verifyNextRunAt?: Date | null;
    },
  ): Promise<string> {
    const { rows } = await owner.$client.query<{ id: string }>(
      `INSERT INTO backup_jobs
         (tenant_id, kind, name, scope_mode, schedule, verify_schedule, enabled, next_run_at, verify_next_run_at)
       VALUES ($1, 'mail', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        tenantId,
        values.name,
        values.scope ?? "selected",
        values.schedule === undefined ? null : JSON.stringify(values.schedule),
        values.verify === undefined ? null : JSON.stringify(values.verify),
        values.enabled ?? true,
        values.nextRunAt === undefined ? null : values.nextRunAt,
        values.verifyNextRunAt === undefined ? null : values.verifyNextRunAt,
      ],
    );
    return rows[0]?.id ?? "";
  }

  async function member(
    tenantId: string,
    jobId: string,
    objectId: string,
    overrides: unknown = {},
    next: Date | null = null,
    verifyNext: Date | null = null,
  ): Promise<string> {
    const { rows } = await owner.$client.query<{ id: string }>(
      `INSERT INTO backup_job_members
         (tenant_id, job_id, protected_object_id, overrides, next_run_at, verify_next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, jobId, objectId, JSON.stringify(overrides), next, verifyNext],
    );
    return rows[0]?.id ?? "";
  }

  async function queued(tenantId: string, queue: string) {
    const { rows } = await owner.$client.query<{
      protected_object_id: string;
      payload: { backupJobId?: string; scheduleId?: string; kind?: string };
    }>(
      "SELECT protected_object_id, payload FROM jobs WHERE tenant_id = $1 AND queue = $2 ORDER BY protected_object_id",
      [tenantId, queue],
    );
    return rows;
  }

  async function jobRow(jobId: string) {
    const { rows } = await owner.$client.query<{
      next_run_at: Date | null;
      last_run_at: Date | null;
      verify_next_run_at: Date | null;
      verify_last_run_at: Date | null;
    }>(
      "SELECT next_run_at, last_run_at, verify_next_run_at, verify_last_run_at FROM backup_jobs WHERE id = $1",
      [jobId],
    );
    return rows[0];
  }

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
    for (const db of [owner, app, provider]) {
      db.$client.on("error", ignoreTerminatedConnection);
    }
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
    const { rows } = await owner.$client.query<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    providerId = rows[0]?.id ?? "";
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

  it("plans a backup per covered object with the job in the payload, and moves the timer on", async () => {
    const contoso = await tenant("contoso");
    const m365 = await source(contoso);
    const anna = await mailbox(contoso, m365, "anna");
    const ben = await mailbox(contoso, m365, "ben");
    await mailbox(contoso, m365, "excluded", "excluded");
    const importSource = await source(contoso, "import");
    await mailbox(contoso, importSource, "imported");
    const all = await job(contoso, { name: "All", scope: "all", schedule: every(480) });

    const summary = await loop().tick();
    expect(summary).toMatchObject({ schedules: 1, enqueued: 2, skipped: 0, deferred: 0 });
    const backups = await queued(contoso, "backup");
    expect(backups.map((row) => row.protected_object_id).sort()).toEqual([anna, ben].sort());
    expect(backups.every((row) => row.payload.backupJobId === all)).toBe(true);
    expect(backups.every((row) => row.payload.scheduleId === undefined)).toBe(true);
    const row = await jobRow(all);
    expect(row?.last_run_at?.toISOString()).toBe(clock.toISOString());
    expect(row?.next_run_at?.toISOString()).toBe("2026-03-04T18:00:00.000Z");

    // Not due again before its time; due at its time, but the object is still queued (skipped).
    clock = new Date("2026-03-04T10:30:00Z");
    expect(await loop().tick()).toMatchObject({ schedules: 0, enqueued: 0 });
    clock = new Date("2026-03-04T18:00:00Z");
    expect(await loop().tick()).toMatchObject({ schedules: 1, enqueued: 0, skipped: 2 });
    expect((await jobRow(all))?.next_run_at?.toISOString()).toBe("2026-03-05T02:00:00.000Z");
  });

  it("plans restore checks on their own schedule", async () => {
    clock = new Date("2026-03-04T10:00:00Z");
    const fabrikam = await tenant("fabrikam");
    const m365 = await source(fabrikam);
    const dora = await mailbox(fabrikam, m365, "dora");
    const checks = await job(fabrikam, {
      name: "Checks",
      scope: "all",
      schedule: every(480),
      verify: cron("0 3 * * *"),
      nextRunAt: new Date("2026-03-05T00:00:00Z"),
      verifyNextRunAt: new Date("2026-03-04T09:00:00Z"),
    });
    expect(await loop().tick()).toMatchObject({ schedules: 1, enqueued: 1 });
    expect(await queued(fabrikam, "backup")).toEqual([]);
    const verifies = await queued(fabrikam, "verify");
    expect(verifies).toHaveLength(1);
    expect(verifies[0]?.protected_object_id).toBe(dora);
    expect(verifies[0]?.payload).toMatchObject({ backupJobId: checks, kind: "verify" });
    const row = await jobRow(checks);
    expect(row?.verify_last_run_at?.toISOString()).toBe(clock.toISOString());
    // 03:00 Berlin the next morning, in UTC.
    expect(row?.verify_next_run_at?.toISOString()).toBe("2026-03-05T02:00:00.000Z");
    // The backup timer was not due and is untouched.
    expect(row?.last_run_at).toBeNull();
  });

  it("runs an object with a schedule of its own on its member's timer, not the job's", async () => {
    clock = new Date("2026-03-04T10:00:00Z");
    const globex = await tenant("globex");
    const m365 = await source(globex);
    const gina = await mailbox(globex, m365, "gina");
    const hugo = await mailbox(globex, m365, "hugo");
    const selected = await job(globex, {
      name: "Selected",
      schedule: every(480),
      nextRunAt: new Date("2026-03-04T09:00:00Z"),
    });
    await member(globex, selected, gina);
    const own = await member(
      globex,
      selected,
      hugo,
      { schedule: every(60) },
      new Date("2026-03-04T09:30:00Z"),
    );
    expect(await loop().tick()).toMatchObject({ schedules: 2, enqueued: 2 });
    const backups = await queued(globex, "backup");
    expect(backups.map((row) => row.protected_object_id).sort()).toEqual([gina, hugo].sort());
    const { rows } = await owner.$client.query<{ next_run_at: Date; last_run_at: Date }>(
      "SELECT next_run_at, last_run_at FROM backup_job_members WHERE id = $1",
      [own],
    );
    expect(rows[0]?.last_run_at.toISOString()).toBe(clock.toISOString());
    expect(rows[0]?.next_run_at.toISOString()).toBe("2026-03-04T11:00:00.000Z");
    expect((await jobRow(selected))?.next_run_at?.toISOString()).toBe("2026-03-04T18:00:00.000Z");
  });

  it("leaves the objects of another job to it", async () => {
    clock = new Date("2026-03-04T10:00:00Z");
    const initech = await tenant("initech");
    const m365 = await source(initech);
    const ivan = await mailbox(initech, m365, "ivan");
    const jana = await mailbox(initech, m365, "jana");
    const rest = await job(initech, { name: "The rest", scope: "all", schedule: every(480) });
    const special = await job(initech, { name: "Special", schedule: every(480) });
    await member(initech, special, ivan);
    expect(await loop().tick()).toMatchObject({ schedules: 2, enqueued: 2 });
    const byJob = new Map(
      (await queued(initech, "backup")).map((row) => [
        row.protected_object_id,
        row.payload.backupJobId,
      ]),
    );
    expect(byJob.get(ivan)).toBe(special);
    expect(byJob.get(jana)).toBe(rest);
  });

  it("does not plan a job that is switched off, has no schedule, or belongs to a suspended tenant", async () => {
    clock = new Date("2026-03-04T10:00:00Z");
    const umbrella = await tenant("umbrella");
    const m365 = await source(umbrella);
    await mailbox(umbrella, m365, "uma");
    await job(umbrella, { name: "Off", scope: "all", schedule: every(480), enabled: false });
    expect(await loop().tick()).toMatchObject({ schedules: 0, enqueued: 0 });
    // A job without a schedule is run by hand only: nothing is due.
    const manual = await tenant("manual");
    const manualSource = await source(manual);
    await mailbox(manual, manualSource, "mia");
    await job(manual, { name: "Manual", scope: "all" });
    expect(await loop().tick()).toMatchObject({ schedules: 0, enqueued: 0 });
    const suspended = await tenant("suspended", "suspended");
    const suspendedSource = await source(suspended);
    await mailbox(suspended, suspendedSource, "sam");
    await job(suspended, { name: "Suspended", scope: "all", schedule: every(480) });
    expect(await loop().tick()).toMatchObject({ schedules: 0, enqueued: 0 });
  });

  it("stops planning a schedule a job took over and keeps planning the ones that stayed", async () => {
    clock = new Date("2026-03-04T10:00:00Z");
    const hooli = await tenant("hooli");
    const m365 = await source(hooli);
    const hank = await mailbox(hooli, m365, "hank");
    const owning = await job(hooli, {
      name: "Owner",
      scope: "all",
      schedule: every(480),
      nextRunAt: new Date("2026-03-05T00:00:00Z"),
    });
    const replaced = (
      await owner.$client.query<{ id: string }>(
        `INSERT INTO schedules (tenant_id, kind, interval_minutes, timezone, superseded_by_job_id, next_run_at)
         VALUES ($1, 'backup', 60, 'UTC', $2, '2026-03-04T09:00:00Z') RETURNING id`,
        [hooli, owning],
      )
    ).rows[0]?.id;
    const stayed = (
      await owner.$client.query<{ id: string }>(
        `INSERT INTO schedules (tenant_id, kind, interval_minutes, timezone, next_run_at)
         VALUES ($1, 'backup', 120, 'UTC', '2026-03-04T09:00:00Z') RETURNING id`,
        [hooli],
      )
    ).rows[0]?.id;
    expect(await loop().tick()).toMatchObject({ schedules: 1, enqueued: 1 });
    const queuedRows = await queued(hooli, "backup");
    expect(queuedRows).toHaveLength(1);
    expect(queuedRows[0]).toMatchObject({ protected_object_id: hank });
    expect(queuedRows[0]?.payload.scheduleId).toBe(stayed);
    const { rows } = await owner.$client.query<{ id: string; last_run_at: Date | null }>(
      "SELECT id, last_run_at FROM schedules WHERE tenant_id = $1",
      [hooli],
    );
    expect(rows.find((row) => row.id === replaced)?.last_run_at).toBeNull();

    // A schedule that is taken over between loading and enqueueing is left alone as well.
    const targets = await store().loadTargets(hooli);
    const [loaded] = await store().loadDue(new Date("2026-03-04T12:30:00Z"), 10);
    expect(loaded?.id).toBe(stayed);
    await owner.$client.query("UPDATE schedules SET superseded_by_job_id = $2 WHERE id = $1", [
      stayed,
      owning,
    ]);
    const result = await store().enqueue(
      boss,
      loaded as never,
      [],
      new Date("2026-03-04T14:00:00Z"),
      clock,
    );
    expect(result).toEqual({ enqueued: 0, skipped: 0 });
    expect(targets.jobMembers).toEqual([]);
  });

  it("leaves a job alone that was changed after the scheduler looked at it", async () => {
    clock = new Date("2026-03-04T10:00:00Z");
    const wayne = await tenant("wayne");
    const m365 = await source(wayne);
    await mailbox(wayne, m365, "walt");
    const watched = await job(wayne, {
      name: "Watched",
      scope: "all",
      schedule: every(480),
      nextRunAt: new Date("2026-03-04T09:00:00Z"),
    });
    const units = await store().loadDueUnits(clock, 50);
    const unit = units.find((candidate) => candidate.job.id === watched);
    if (!unit) throw new Error("the job is due");
    // The api gave it another schedule meanwhile (a new next run).
    await owner.$client.query(
      "UPDATE backup_jobs SET next_run_at = '2026-03-04T22:00:00Z' WHERE id = $1",
      [watched],
    );
    const targets = await store().loadTargets(wayne);
    const planned = expandJobUnit(unit, targets, () => "00000000-0000-4000-8000-0000000000aa");
    expect(planned).toHaveLength(1);
    const result = await store().enqueueUnit(
      boss,
      unit,
      planned,
      new Date("2026-03-04T18:00:00Z"),
      unit.job.nextRunAt,
      clock,
    );
    expect(result).toEqual({ enqueued: 0, skipped: 0 });
    expect(await queued(wayne, "backup")).toEqual([]);
    expect((await jobRow(watched))?.next_run_at?.toISOString()).toBe("2026-03-04T22:00:00.000Z");
    // The same, when the job was switched off or deleted.
    await owner.$client.query("UPDATE backup_jobs SET enabled = false WHERE id = $1", [watched]);
    const second = await store().enqueueUnit(
      boss,
      unit,
      planned,
      new Date("2026-03-04T18:00:00Z"),
      new Date("2026-03-04T22:00:00Z"),
      clock,
    );
    expect(second).toEqual({ enqueued: 0, skipped: 0 });
  });

  it("defers a job whose schedule cannot be planned instead of trying it on every tick", async () => {
    clock = new Date("2026-03-04T10:00:00Z");
    const stark = await tenant("stark");
    const m365 = await source(stark);
    await mailbox(stark, m365, "tony");
    const broken = await job(stark, { name: "Broken", scope: "all", schedule: cron("not a cron") });
    expect(await loop().tick()).toMatchObject({ schedules: 1, enqueued: 0, deferred: 1 });
    expect((await jobRow(broken))?.next_run_at?.toISOString()).toBe("2026-03-04T11:00:00.000Z");
    expect(await loop().tick()).toMatchObject({ schedules: 0, deferred: 0 });
  });

  it("reads only the member rows of the tenant it plans for", async () => {
    const left = await tenant("left");
    const right = await tenant("right");
    const leftObject = await mailbox(left, await source(left), "lena");
    const rightObject = await mailbox(right, await source(right), "rolf");
    await member(left, await job(left, { name: "Left", schedule: every(480) }), leftObject);
    await member(right, await job(right, { name: "Right", schedule: every(480) }), rightObject);
    const targets = await store().loadTargets(left);
    expect(targets.jobMembers?.map((row) => row.protectedObjectId)).toEqual([leftObject]);
    expect(targets.protectedObjects.map((row) => row.id)).toEqual([leftObject]);
  });
});
