// File share jobs of the scheduler (docs/FILESHARES.md 8.1) against a real Postgres: which share
// jobs, members with a schedule of their own and copy jobs are due, what gets queued for each,
// how the timers move on, and which maintenance is due. A recorder stands in for pg-boss.
//
// The scan runs on the installation role (BYPASSRLS), as in production. Runs when
// RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser; skipped otherwise.

import { randomBytes, randomUUID } from "node:crypto";
import { FILE_SHARE_QUEUES } from "@restow/core";
import { type RoleLogin, createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import type PgBoss from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FILE_SHARE_QUEUE_OPTIONS, FileShareJobPlanner, shareNextRunAt } from "./file-shares.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const TEST_DB = `restow_scheduler_file_shares_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_sfs_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_sfs_inst_${suffix}`,
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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DAILY = { kind: "daily", timeOfDay: "02:00", timeZone: "UTC" };

describe("shareNextRunAt", () => {
  it("plans interval, cron and daily schedules, and nothing for a broken one", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(
      shareNextRunAt({ kind: "interval", intervalMinutes: 120, timeZone: "UTC" }, "j", now),
    ).toEqual(new Date("2026-10-10T14:00:00Z"));
    expect(
      shareNextRunAt({ kind: "daily", timeOfDay: "02:00", timeZone: "UTC" }, "j", now),
    ).toEqual(new Date("2026-10-11T02:00:00Z"));
    expect(shareNextRunAt({ kind: "cron", cron: "30 1 * * *", timeZone: "UTC" }, "j", now)).toEqual(
      new Date("2026-10-11T01:30:00Z"),
    );
    expect(shareNextRunAt({ kind: "daily", timeZone: "UTC" }, "j", now)).toBeNull();
    expect(
      shareNextRunAt({ kind: "cron", cron: "nonsense", timeZone: "UTC" }, "j", now),
    ).toBeNull();
  });

  it("creates every file share queue with the shared settings", () => {
    expect(Object.keys(FILE_SHARE_QUEUE_OPTIONS).sort()).toEqual(
      Object.values(FILE_SHARE_QUEUES).sort(),
    );
  });
});

describe.skipIf(!adminUrl)("file share jobs of the scheduler", () => {
  let owner: ReturnType<typeof createDb>;
  let provider: ReturnType<typeof createDb>;
  let tenantId: string;
  let suspendedTenantId: string;
  const now = new Date();
  let sent: { queue: string; data: Record<string, unknown>; options: PgBoss.SendOptions }[] = [];
  const recorder = {
    send: async (queue: string, data: Record<string, unknown>, options: PgBoss.SendOptions) => {
      sent.push({ queue, data, options });
      return randomUUID();
    },
  } as unknown as PgBoss;

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    owner.$client.query<T>(text, values).then((result) => result.rows);

  async function share(
    fields: {
      tenant?: string;
      retired?: boolean;
      snapshot?: boolean;
      retentionAt?: Date | null;
      checkAt?: Date | null;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const tenant = fields.tenant ?? tenantId;
    await q(
      `INSERT INTO file_shares (id, tenant_id, name, protocol, server, export_path, retired_at,
                                last_retention_at, last_check_at, last_success_at)
       VALUES ($1, $2, $3, 'nfs', 'nfs.example.test', '/srv', $4, $5, $6, now())`,
      [
        id,
        tenant,
        `share-${id.slice(0, 8)}`,
        fields.retired ? new Date() : null,
        fields.retentionAt ?? null,
        fields.checkAt ?? null,
      ],
    );
    if (fields.snapshot !== false) {
      const [snap] = await q<{ id: string }>(
        `INSERT INTO file_share_snapshots (tenant_id, file_share_id, sequence, restic_snapshot_id, snapshot_time)
         VALUES ($1, $2, 1, $3, now()) RETURNING id`,
        [tenant, id, randomBytes(32).toString("hex")],
      );
      await q("UPDATE file_shares SET last_snapshot_id = $2 WHERE id = $1", [id, snap?.id]);
    }
    return id;
  }

  async function job(fields: {
    kind?: "share" | "copy";
    tenant?: string;
    schedule?: object | null;
    nextRunAt?: Date | null;
    enabled?: boolean;
    source?: string;
    target?: string;
  }): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO backup_jobs (id, tenant_id, kind, name, schedule, next_run_at, enabled,
                                source_file_share_id, target_file_share_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        fields.tenant ?? tenantId,
        fields.kind ?? "share",
        `job-${id.slice(0, 8)}`,
        fields.schedule === undefined
          ? JSON.stringify(DAILY)
          : fields.schedule === null
            ? null
            : JSON.stringify(fields.schedule),
        fields.nextRunAt ?? null,
        fields.enabled ?? true,
        fields.source ?? null,
        fields.target ?? null,
      ],
    );
    return id;
  }

  async function member(
    jobId: string,
    shareId: string,
    overrides: object = {},
    nextRunAt: Date | null = null,
  ) {
    const id = randomUUID();
    await q(
      `INSERT INTO backup_job_members (id, tenant_id, job_id, file_share_id, overrides, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenantId, jobId, shareId, JSON.stringify(overrides), nextRunAt],
    );
    return id;
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
    provider = createDb(urlFor(base, installationLogin));
    for (const db of [owner, provider]) {
      db.$client.on("error", ignoreTerminatedConnection);
    }
    const [providerRow] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const tenants = await q<{ id: string }>(
      `INSERT INTO tenants (provider_id, name, slug, status)
       VALUES ($1, 'Contoso', 'contoso', 'active'), ($1, 'Suspended', 'suspended', 'suspended')
       RETURNING id`,
      [providerRow?.id],
    );
    tenantId = tenants[0]?.id ?? "";
    suspendedTenantId = tenants[1]?.id ?? "";
  }, 90_000);

  afterAll(async () => {
    await Promise.all([provider?.$client.end(), owner?.$client.end()]);
    await dropTestDatabase(adminUrl as string, TEST_DB);
    const admin = createDb(adminUrl as string);
    try {
      await admin.$client.query(`DROP ROLE IF EXISTS ${tenantLogin.name}`);
      await admin.$client.query(`DROP ROLE IF EXISTS ${installationLogin.name}`);
    } finally {
      await admin.$client.end();
    }
  });

  beforeEach(async () => {
    sent = [];
    await q("DELETE FROM backup_jobs");
  });

  const planner = () => new FileShareJobPlanner({ installation: provider.$client }, recorder, 0);

  it("queues a backup of every member share of a due job, and moves the job's timer on", async () => {
    const a = await share();
    const b = await share();
    const retired = await share({ retired: true });
    const own = await share();
    const due = await job({ nextRunAt: new Date(now.getTime() - HOUR) });
    await member(due, a);
    await member(due, b);
    await member(due, retired);
    // A member with its own schedule runs on its own timer.
    await member(
      due,
      own,
      { schedule: { kind: "interval", intervalMinutes: 240, timeZone: "UTC" } },
      new Date(now.getTime() + HOUR),
    );
    const notYet = await job({ nextRunAt: new Date(now.getTime() + HOUR) });
    await member(notYet, await share());
    const off = await job({ enabled: false });
    await member(off, await share());
    const handOnly = await job({ schedule: null });
    await member(handOnly, await share());
    const suspended = await job({ tenant: suspendedTenantId });

    const counts = await planner().plan(now);
    expect(counts?.backup).toBe(2);
    const backups = sent.filter((entry) => entry.queue === FILE_SHARE_QUEUES.backup);
    expect(backups.map((entry) => entry.data.fileShareId).sort()).toEqual([a, b].sort());
    expect(backups[0]?.data).toMatchObject({ tenantId, backupJobId: due, trigger: "schedule" });
    expect(backups.map((entry) => entry.options.singletonKey).sort()).toEqual(
      [`file-share-backup:${a}`, `file-share-backup:${b}`].sort(),
    );
    const [row] = await q<{ next_run_at: Date; last_run_at: Date }>(
      "SELECT next_run_at, last_run_at FROM backup_jobs WHERE id = $1",
      [due],
    );
    expect(row?.next_run_at.getTime()).toBeGreaterThan(now.getTime());
    expect(row?.last_run_at).not.toBeNull();
    expect(suspended).toBeDefined();
    // Not due again on the next pass.
    sent = [];
    await planner().plan(now);
    expect(sent.filter((entry) => entry.queue === FILE_SHARE_QUEUES.backup)).toEqual([]);
  });

  it("plans a member with a schedule of its own on its own timer", async () => {
    const own = await share();
    const parent = await job({ nextRunAt: new Date(now.getTime() + DAY) });
    const id = await member(parent, own, {
      schedule: { kind: "interval", intervalMinutes: 120, timeZone: "UTC" },
    });
    const counts = await planner().plan(now);
    expect(counts?.backup).toBe(1);
    expect(sent.find((entry) => entry.queue === FILE_SHARE_QUEUES.backup)?.data).toMatchObject({
      fileShareId: own,
      backupJobId: parent,
      intervalMinutes: 120,
    });
    const [row] = await q<{ next_run_at: Date }>(
      "SELECT next_run_at FROM backup_job_members WHERE id = $1",
      [id],
    );
    expect(row?.next_run_at.getTime()).toBe(now.getTime() + 2 * HOUR);
  });

  it("queues a due copy job once", async () => {
    const source = await share();
    const target = await share();
    const copy = await job({ kind: "copy", source, target });
    await planner().plan(now);
    const copies = sent.filter((entry) => entry.queue === FILE_SHARE_QUEUES.copy);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.data).toEqual({ tenantId, backupJobId: copy });
    expect(copies[0]?.options.singletonKey).toBe(`file-share-copy:${copy}`);
  });

  it("defers a job whose schedule cannot be planned", async () => {
    const broken = await job({ schedule: { kind: "cron", cron: "nope", timeZone: "UTC" } });
    await member(broken, await share());
    await planner().plan(now);
    expect(sent.filter((entry) => entry.queue === FILE_SHARE_QUEUES.backup)).toEqual([]);
    const [row] = await q<{ next_run_at: Date }>(
      "SELECT next_run_at FROM backup_jobs WHERE id = $1",
      [broken],
    );
    expect(row?.next_run_at.getTime()).toBeGreaterThan(now.getTime());
  });

  it("finds retention, check, restore check and catalog due from the share rows", async () => {
    const fresh = await share({ retentionAt: now, checkAt: now });
    const old = await share({
      retentionAt: new Date(now.getTime() - 2 * DAY),
      checkAt: new Date(now.getTime() - 8 * DAY),
    });
    const retired = await share({ retired: true });
    const empty = await share({ snapshot: false });
    const suspended = await share({ tenant: suspendedTenantId });
    // `old` has samples for its newest restore point and no restore check yet.
    const [snap] = await q<{ id: string; restic_snapshot_id: string }>(
      "SELECT s.id, s.restic_snapshot_id FROM file_share_snapshots s WHERE s.file_share_id = $1",
      [old],
    );
    const [run] = await q<{ id: string }>(
      `INSERT INTO file_share_runs (tenant_id, file_share_id, lock_share_id, kind, status)
       VALUES ($1, $2, $2, 'backup', 'succeeded') RETURNING id`,
      [tenantId, old],
    );
    await q(
      `INSERT INTO file_share_samples (tenant_id, file_share_id, run_id, snapshot_id, path, sha256, size)
       VALUES ($1, $2, $3, $4, '/share/a', $5, 1)`,
      [tenantId, old, run?.id, snap?.restic_snapshot_id, "0".repeat(64)],
    );
    // `fresh` has samples and a restore check of its newest point already.
    const [freshSnap] = await q<{ restic_snapshot_id: string }>(
      "SELECT restic_snapshot_id FROM file_share_snapshots WHERE file_share_id = $1",
      [fresh],
    );
    const [freshRun] = await q<{ id: string }>(
      `INSERT INTO file_share_runs (tenant_id, file_share_id, lock_share_id, kind, status)
       VALUES ($1, $2, $2, 'backup', 'succeeded') RETURNING id`,
      [tenantId, fresh],
    );
    await q(
      `INSERT INTO file_share_samples (tenant_id, file_share_id, run_id, snapshot_id, path, sha256, size)
       VALUES ($1, $2, $3, $4, '/share/a', $5, 1)`,
      [tenantId, fresh, freshRun?.id, freshSnap?.restic_snapshot_id, "0".repeat(64)],
    );
    await q(
      `INSERT INTO file_share_reports (tenant_id, file_share_id, kind, readiness, snapshot_id)
       VALUES ($1, $2, 'restore_test', 'green', $3)`,
      [tenantId, fresh, freshSnap?.restic_snapshot_id],
    );
    await q("UPDATE file_share_snapshots SET cataloged_at = now() WHERE file_share_id = $1", [
      fresh,
    ]);

    const due = await planner().dueMaintenance(now);
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
    expect(ids(due.retention)).toContain(old);
    expect(ids(due.retention)).not.toContain(fresh);
    expect(ids(due.retention)).not.toContain(retired);
    expect(ids(due.retention)).not.toContain(empty);
    expect(ids(due.retention)).not.toContain(suspended);
    expect(ids(due.check)).toContain(old);
    expect(ids(due.check)).toContain(retired);
    expect(ids(due.check)).not.toContain(fresh);
    expect(ids(due.verify)).toEqual([old]);
    expect(ids(due.catalog)).toContain(old);
    expect(ids(due.catalog)).not.toContain(fresh);

    const counts = await planner().plan(now);
    expect(counts?.monitor).toBe(1);
    const forOld = sent
      .filter((entry) => entry.data.fileShareId === old)
      .map((entry) => entry.queue);
    expect(forOld.sort()).toEqual(
      [
        FILE_SHARE_QUEUES.catalog,
        FILE_SHARE_QUEUES.check,
        FILE_SHARE_QUEUES.retention,
        FILE_SHARE_QUEUES.verify,
      ].sort(),
    );
    expect(
      sent.find((entry) => entry.queue === FILE_SHARE_QUEUES.retention)?.options.singletonSeconds,
    ).toBe(3600);
  });
});
