// The recommended schedules, applied by the scheduler on the database roles it
// runs on in production: a tenant with an active source and no marker gets the
// recommended set on the next tick (tenant-pinned, under Row Level Security),
// the backup job and directory sync it brings are due at once and enqueue jobs
// in the same tick, a second tick adds nothing, and a schedule an administrator
// deleted afterwards stays deleted. Backups and restore checks are one mail job
// since 0.2.0 (the maintenance is still made of schedules).
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser
// (a uniquely named database and roles are created and dropped again); skipped
// otherwise.

import { randomBytes } from "node:crypto";
import { type RoleLogin, createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_QUEUES, pgBossQueueOptions } from "./queues.js";
import { SchedulerLoop } from "./scheduler.js";
import { ScheduleStore } from "./store.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const TEST_DB = `restow_scheduler_defaults_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_sched_defaults_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_sched_defaults_provider_${suffix}`,
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

interface ScheduleRecord {
  kind: string;
  interval_minutes: number | null;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  next_run_at: Date | null;
  last_run_at: Date | null;
}

describe.skipIf(!adminUrl)("recommended schedules applied by the scheduler", () => {
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let provider: ReturnType<typeof createDb>;
  let boss: PgBoss;
  let providerId: string;
  let clock = new Date("2026-03-04T10:00:00Z");
  let jobCounter = 0;

  const loop = (timezone = "Europe/Berlin") =>
    new SchedulerLoop({
      store: new ScheduleStore({ tenant: app.$client, installation: provider.$client }),
      boss,
      tickIntervalMs: 60_000,
      batchSize: 50,
      deferMs: 3_600_000,
      isLeader: () => true,
      recommendedDefaults: { timezone },
      now: () => clock,
      newJobId: () => {
        jobCounter++;
        return `00000000-0000-4000-8000-${jobCounter.toString().padStart(12, "0")}`;
      },
    });

  async function tenant(slug: string, status = "active"): Promise<string> {
    const { rows } = await owner.$client.query<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug, status) VALUES ($1, $2, $2, $3) RETURNING id",
      [providerId, slug, status],
    );
    return rows[0]?.id ?? "";
  }

  async function source(tenantId: string, kind: "m365" | "imap", status: string): Promise<string> {
    const { rows } = await owner.$client.query<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, $2, $3, $4) RETURNING id",
      [tenantId, kind, kind.toUpperCase(), status],
    );
    return rows[0]?.id ?? "";
  }

  async function mailbox(tenantId: string, sourceId: string, externalId: string): Promise<string> {
    const { rows } = await owner.$client.query<{ id: string }>(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, status)
       VALUES ($1, $2, 'mailbox', $3, 'active') RETURNING id`,
      [tenantId, sourceId, externalId],
    );
    return rows[0]?.id ?? "";
  }

  async function schedulesOf(tenantId: string): Promise<ScheduleRecord[]> {
    const { rows } = await owner.$client.query<ScheduleRecord>(
      `SELECT kind, interval_minutes, cron, timezone, enabled, next_run_at, last_run_at
         FROM schedules WHERE tenant_id = $1 ORDER BY kind, cron NULLS FIRST`,
      [tenantId],
    );
    return rows;
  }

  interface JobRecord {
    name: string;
    scope_mode: string;
    schedule: unknown;
    verify_schedule: unknown;
    next_run_at: Date | null;
    last_run_at: Date | null;
    verify_next_run_at: Date | null;
    verify_last_run_at: Date | null;
  }

  async function jobsOf(tenantId: string): Promise<JobRecord[]> {
    const { rows } = await owner.$client.query<JobRecord>(
      `SELECT name, scope_mode, schedule, verify_schedule, next_run_at, last_run_at,
              verify_next_run_at, verify_last_run_at
         FROM backup_jobs WHERE tenant_id = $1 AND kind = 'mail' ORDER BY name`,
      [tenantId],
    );
    return rows;
  }

  async function markerOf(tenantId: string): Promise<Date | null> {
    const { rows } = await owner.$client.query<{ schedule_defaults_applied_at: Date | null }>(
      "SELECT schedule_defaults_applied_at FROM tenants WHERE id = $1",
      [tenantId],
    );
    return rows[0]?.schedule_defaults_applied_at ?? null;
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
    // The forced DROP DATABASE in afterAll waits for these connections to close
    // (testing/database.ts); one it still terminates surfaces as an "error"
    // event on its ended pool (for pg-boss, on the PgBoss instance) and would
    // fail the run although every test passed. Only that termination is
    // ignored; any other error is rethrown, and a failing query still rejects
    // its own promise.
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

  it("gives a tenant with an active source the recommended set and runs the due ones at once", async () => {
    const contoso = await tenant("contoso");
    const m365 = await source(contoso, "m365", "active");
    const mailboxes = [
      await mailbox(contoso, m365, "a@contoso.example"),
      await mailbox(contoso, m365, "b@contoso.example"),
    ];
    // Not yet: a tenant whose only source still waits for consent, and a suspended one.
    const pending = await tenant("pending");
    await source(pending, "m365", "pending");
    const suspended = await tenant("suspended", "suspended");
    await source(suspended, "imap", "active");

    const summary = await loop().tick();
    // Backup and directory sync are due at once: two backup jobs, one directory sync.
    expect(summary).toEqual({
      tenantsInitialised: 1,
      schedules: 2,
      enqueued: 3,
      skipped: 0,
      deferred: 0,
      reportsFired: 0,
      reportDeliveries: 0,
    });

    const schedules = await schedulesOf(contoso);
    // The maintenance is made of schedules; backups and restore checks are the one mail job.
    expect(
      schedules.map((row) => [row.kind, row.interval_minutes, row.cron, row.timezone, row.enabled]),
    ).toEqual([
      ["retention", null, "30 4 * * *", "Europe/Berlin", true],
      ["scrub", null, "0 4 * * 6", "Europe/Berlin", true],
      ["scrub", null, "0 5 1 * *", "Europe/Berlin", true],
      ["directory", 360, null, "Europe/Berlin", true],
    ]);
    const byCron = new Map(schedules.map((row) => [row.cron ?? row.kind, row]));
    // The intervals ran now and moved on; the cron entries wait for Berlin night time.
    expect(byCron.get("directory")?.next_run_at?.toISOString()).toBe("2026-03-04T16:00:00.000Z");
    expect(byCron.get("30 4 * * *")?.next_run_at?.toISOString()).toBe("2026-03-05T03:30:00.000Z");
    expect(byCron.get("0 5 1 * *")?.next_run_at?.toISOString()).toBe("2026-04-01T03:00:00.000Z");
    const [job] = await jobsOf(contoso);
    expect(job).toMatchObject({
      // The tenant has no language of its own: the installation's default names the job.
      name: "Mail-Sicherung",
      scope_mode: "all",
      schedule: { kind: "interval", intervalMinutes: 480, timeZone: "Europe/Berlin" },
      verify_schedule: { kind: "cron", cron: "0 3 * * 0", timeZone: "Europe/Berlin" },
    });
    expect(job?.last_run_at?.toISOString()).toBe(clock.toISOString());
    expect(job?.next_run_at?.toISOString()).toBe("2026-03-04T18:00:00.000Z");
    expect(job?.verify_next_run_at?.toISOString()).toBe("2026-03-08T02:00:00.000Z");
    expect(job?.verify_last_run_at).toBeNull();
    expect((await markerOf(contoso))?.toISOString()).toBe(clock.toISOString());

    const jobs = await owner.$client.query<{ queue: string; protected_object_id: string | null }>(
      "SELECT queue, protected_object_id FROM jobs WHERE tenant_id = $1 ORDER BY queue, protected_object_id",
      [contoso],
    );
    expect(jobs.rows.map((row) => row.queue)).toEqual(["backup", "backup", "directory"]);
    expect(
      jobs.rows
        .filter((row) => row.queue === "backup")
        .map((row) => row.protected_object_id)
        .sort(),
    ).toEqual([...mailboxes].sort());

    expect(await schedulesOf(pending)).toEqual([]);
    expect(await markerOf(pending)).toBeNull();
    expect(await schedulesOf(suspended)).toEqual([]);
    expect(await markerOf(suspended)).toBeNull();
  });

  it("adds nothing on the next tick and never recreates a schedule an admin deleted", async () => {
    const [contoso] = (
      await owner.$client.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'contoso'")
    ).rows;
    const tenantId = contoso?.id ?? "";
    const before = await schedulesOf(tenantId);

    clock = new Date("2026-03-04T10:05:00Z");
    expect(await loop().tick()).toMatchObject({ tenantsInitialised: 0, schedules: 0 });
    expect(await schedulesOf(tenantId)).toEqual(before);

    await owner.$client.query("DELETE FROM schedules WHERE tenant_id = $1 AND kind = 'retention'", [
      tenantId,
    ]);
    clock = new Date("2026-03-04T10:10:00Z");
    expect(await loop().tick()).toMatchObject({ tenantsInitialised: 0 });
    const after = await schedulesOf(tenantId);
    expect(after.map((row) => row.kind)).not.toContain("retention");
    expect(after).toHaveLength(before.length - 1);
  });

  it("fills only the gaps: an admin's own backup schedule stays the only one", async () => {
    const fabrikam = await tenant("fabrikam");
    await source(fabrikam, "imap", "active");
    await owner.$client.query(
      `INSERT INTO schedules (tenant_id, kind, interval_minutes, next_run_at)
       VALUES ($1, 'backup', 120, '2026-03-05T00:00:00Z')`,
      [fabrikam],
    );

    clock = new Date("2026-03-04T11:00:00Z");
    expect(await loop("America/New_York").tick()).toMatchObject({ tenantsInitialised: 1 });
    const schedules = await schedulesOf(fabrikam);
    // No directory sync without a Microsoft 365 source; the admin's backup schedule is kept as it
    // was (it covers the backup recommendation), and the missing restore check becomes the job.
    expect(schedules.map((row) => [row.kind, row.interval_minutes, row.cron])).toEqual([
      ["backup", 120, null],
      ["retention", null, "30 4 * * *"],
      ["scrub", null, "0 4 * * 6"],
      ["scrub", null, "0 5 1 * *"],
    ]);
    // The zone the scheduler was configured with: 03:00 on Sunday in New York,
    // which is already daylight time that night (clocks go forward at 02:00).
    const [job] = await jobsOf(fabrikam);
    expect(job).toMatchObject({
      scope_mode: "all",
      schedule: null,
      verify_schedule: { kind: "cron", cron: "0 3 * * 0", timeZone: "America/New_York" },
    });
    expect(job?.verify_next_run_at?.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("recreates only what is missing when the marker is cleared", async () => {
    const [contoso] = (
      await owner.$client.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'contoso'")
    ).rows;
    const tenantId = contoso?.id ?? "";
    await owner.$client.query(
      "UPDATE tenants SET schedule_defaults_applied_at = NULL WHERE id = $1",
      [tenantId],
    );
    clock = new Date("2026-03-04T12:00:00Z");
    expect(await loop().tick()).toMatchObject({ tenantsInitialised: 1 });
    const kinds = (await schedulesOf(tenantId)).map((row) => row.kind);
    // Only the retention schedule the admin deleted came back; the job is not made twice.
    expect(kinds.filter((kind) => kind === "retention")).toHaveLength(1);
    expect(kinds).toHaveLength(4);
    expect(await jobsOf(tenantId)).toHaveLength(1);
  });

  it("leaves the defaults alone when not configured", async () => {
    const northwind = await tenant("northwind");
    await source(northwind, "imap", "active");
    const plain = new SchedulerLoop({
      store: new ScheduleStore({ tenant: app.$client, installation: provider.$client }),
      boss,
      tickIntervalMs: 60_000,
      batchSize: 50,
      deferMs: 3_600_000,
      isLeader: () => true,
      now: () => clock,
    });
    expect(await plain.tick()).toMatchObject({ tenantsInitialised: 0 });
    expect(await schedulesOf(northwind)).toEqual([]);
  });

  it("does not count the import source as a connected source", async () => {
    // A tenant that only imported mail files has nothing to back up yet: the
    // recommended set (and its one-time marker) waits for a real source.
    const importer = await tenant("importer");
    const { rows } = await owner.$client.query<{ id: string }>(
      `INSERT INTO sources (tenant_id, kind, name, status)
       VALUES ($1, 'import', 'Imported mail files', 'active') RETURNING id`,
      [importer],
    );
    await owner.$client.query(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, origin, external_id, status)
       VALUES ($1, $2, 'imap', 'manual', 'import-1', 'active')`,
      [importer, rows[0]?.id],
    );

    await loop().tick();
    expect(await schedulesOf(importer)).toEqual([]);
    expect(await markerOf(importer)).toBeNull();

    // The first real source starts the defaults, and only the real source's objects are planned.
    await source(importer, "imap", "active");
    await loop().tick();
    expect(await markerOf(importer)).not.toBeNull();
    expect(await jobsOf(importer)).toHaveLength(1);
    const { rows: queued } = await owner.$client.query<{ protected_object_id: string | null }>(
      "SELECT protected_object_id FROM jobs WHERE tenant_id = $1 AND queue = 'backup'",
      [importer],
    );
    // Nothing is planned for the imported mailbox (the real source has no mailbox).
    expect(queued).toHaveLength(0);
  });
});
