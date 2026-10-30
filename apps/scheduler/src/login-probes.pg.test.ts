// The login-probe planner against a real Postgres and a real pg-boss: which shut-down IMAP
// accounts are due (and which are not), that an archive-only or job-less account is probed,
// that a probe is one `backup` job with its `jobs` row and the object's usual singleton key, and
// that the planner never moves the due time.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
// `restow_scheduler_login_probes_test` is recreated there); skipped otherwise.

import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoginProbePlanner } from "./login-probes.js";
import { JOB_QUEUES, pgBossQueueOptions } from "./queues.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_scheduler_login_probes_test";
const HOUR = 3_600_000;

describe.skipIf(!adminUrl)("login probes of the scheduler", () => {
  let db: ReturnType<typeof createDb>;
  let boss: PgBoss;
  let tenantId: string;
  let suspendedTenantId: string;
  let sources: Record<string, string>;
  let counter = 0;
  const now = new Date("2026-10-30T12:00:00Z");

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    db.$client.query<T>(text, values).then((result) => result.rows);

  const planner = () =>
    new LoginProbePlanner({ tenant: db.$client, installation: db.$client }, boss, 0, () => {
      counter++;
      return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
    });

  async function account(options: {
    source?: string;
    tenant?: string;
    status?: string;
    reason?: string | null;
    kind?: string;
    due?: Date | null;
  }): Promise<string> {
    const tenant = options.tenant ?? tenantId;
    const source = options.source ?? sources.active;
    const status = options.status ?? "orphaned";
    const reason = options.reason === undefined ? "login_refused" : options.reason;
    const confirmed = reason === "login_refused";
    const [row] = await q<{ id: string }>(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, status, status_reason,
                                      status_confirmed_at, status_confirmed_by, external_id,
                                      login_probe_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        tenant,
        source,
        options.kind ?? "imap",
        status,
        reason,
        confirmed ? now : null,
        confirmed ? "admin@example.test" : null,
        `acct-${++counter}@example.test`,
        options.due === undefined ? new Date(now.getTime() - HOUR) : options.due,
      ],
    );
    return row?.id as string;
  }

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    try {
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.$client.end();
    }
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    db.$client.on("error", ignoreTerminatedConnection);
    boss = new PgBoss({ connectionString: url.toString(), schedule: false, supervise: false });
    boss.on("error", ignoreTerminatedConnection);
    await boss.start();
    for (const queue of JOB_QUEUES) {
      await boss.createQueue(queue, pgBossQueueOptions(queue));
    }
    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const tenants = await q<{ id: string }>(
      `INSERT INTO tenants (provider_id, name, slug, status)
       VALUES ($1, 'Contoso', 'contoso', 'active'), ($1, 'Suspended', 'suspended', 'suspended')
       RETURNING id`,
      [provider?.id],
    );
    tenantId = tenants[0]?.id as string;
    suspendedTenantId = tenants[1]?.id as string;
    sources = {};
    for (const status of ["active", "error", "disabled", "pending"]) {
      const [row] = await q<{ id: string }>(
        "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'imap', $2, $3) RETURNING id",
        [tenantId, `Mail ${status}`, status],
      );
      sources[status] = row?.id as string;
    }
    const [m365] = await q<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'm365', 'M365', 'active') RETURNING id",
      [tenantId],
    );
    sources.m365 = m365?.id as string;
    const [other] = await q<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'imap', 'Mail', 'active') RETURNING id",
      [suspendedTenantId],
    );
    sources.suspended = other?.id as string;
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true }).catch(() => undefined);
    await db?.$client.end();
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  it("finds the shut-down accounts whose probe is due, and only those", async () => {
    const due = await account({});
    const reachable = await account({ source: sources.error });
    const notDue = await account({ due: new Date(now.getTime() + HOUR) });
    // The database never lets a shut-down account lose its probe date (it would be invisible).
    await expect(account({ due: null })).rejects.toMatchObject({
      constraint: "protected_objects_login_refused_ck",
    });
    const disabled = await account({ source: sources.disabled });
    const pending = await account({ source: sources.pending });
    const suspended = await account({ tenant: suspendedTenantId, source: sources.suspended });
    const active = await account({ status: "active", reason: null });
    const otherReason = await account({
      reason: "account_disabled",
      kind: "mailbox",
      source: sources.m365,
    });
    const found = (await planner().due(now)).map((row) => row.id);
    expect(found).toContain(due);
    expect(found).toContain(reachable);
    for (const skipped of [notDue, disabled, pending, suspended, active, otherReason]) {
      expect(found).not.toContain(skipped);
    }
  });

  it("queues one backup job per due account, with its jobs row and the object's singleton key", async () => {
    // An archive-only or job-less account: no schedule and no mail job reaches it.
    const id = await account({});
    const queued = await planner().plan(now);
    expect(queued).toBeGreaterThanOrEqual(1);
    const rows = await q<{
      id: string;
      queue: string;
      status: string;
      payload: Record<string, unknown>;
    }>("SELECT id, queue, status, payload FROM jobs WHERE protected_object_id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queue: "backup", status: "queued" });
    expect(rows[0]?.payload).toEqual({
      jobId: rows[0]?.id,
      tenantId,
      protectedObjectId: id,
    });
    const boss_jobs = await q<{ singleton_key: string; priority: number }>(
      "SELECT singleton_key, priority FROM pgboss.job WHERE name = 'backup' AND singleton_key = $1",
      [`backup:${id}`],
    );
    expect(boss_jobs).toHaveLength(1);
    expect(boss_jobs[0]?.priority).toBe(40);
  });

  it("does not queue a probe twice while one waits, and never moves the due time", async () => {
    const id = await account({});
    const due = (
      await q<{ d: Date }>("SELECT login_probe_due_at AS d FROM protected_objects WHERE id = $1", [
        id,
      ])
    )[0]?.d;
    const first = planner();
    await first.plan(now);
    await first.plan(new Date(now.getTime() + 60_000));
    await planner().plan(new Date(now.getTime() + 120_000));
    const rows = await q("SELECT id FROM jobs WHERE protected_object_id = $1", [id]);
    expect(rows).toHaveLength(1);
    const after = (
      await q<{ d: Date }>("SELECT login_probe_due_at AS d FROM protected_objects WHERE id = $1", [
        id,
      ])
    )[0]?.d;
    expect(after?.toISOString()).toBe(due?.toISOString());
  });

  it("does nothing within the planning interval", async () => {
    const slow = new LoginProbePlanner(
      { tenant: db.$client, installation: db.$client },
      boss,
      60_000,
    );
    expect(await slow.plan(now)).not.toBeNull();
    expect(await slow.plan(new Date(now.getTime() + 1_000))).toBeNull();
  });
});
