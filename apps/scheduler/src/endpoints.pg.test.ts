// Endpoint jobs of the scheduler (docs/AGENT.md) against a real Postgres and a
// real pg-boss: what is due for retention, repository check and restore test,
// which queues get which job, and that a job is spaced out and never queued
// twice for the same endpoint.
//
// The scan runs on the installation role (BYPASSRLS), as in production. Runs
// when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser
// (uniquely named roles are created and dropped again); skipped otherwise.

import { randomBytes, randomUUID } from "node:crypto";
import { ENDPOINT_QUEUES } from "@restow/core";
import { type RoleLogin, createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENDPOINT_QUEUE_OPTIONS, EndpointJobPlanner } from "./endpoints.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const TEST_DB = `restow_scheduler_endpoints_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_se_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_se_inst_${suffix}`,
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

describe.skipIf(!adminUrl)("endpoint jobs of the scheduler", () => {
  let owner: ReturnType<typeof createDb>;
  let provider: ReturnType<typeof createDb>;
  let boss: PgBoss;
  let tenantId: string;
  let suspendedTenantId: string;
  const now = new Date();

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    owner.$client.query<T>(text, values).then((result) => result.rows);

  async function endpoint(fields: {
    tenant?: string;
    status?: "active" | "revoked";
    snapshot?: string | null;
    retentionAt?: Date | null;
    checkAt?: Date | null;
  }): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO endpoints (id, tenant_id, hostname, os, arch, profile, status, secret_hash, config,
                              last_snapshot_id, last_retention_at, last_check_at)
       VALUES ($1, $2, $3, 'linux', 'amd64', 'server', $4, 'h', '{}'::jsonb, $5, $6, $7)`,
      [
        id,
        fields.tenant ?? tenantId,
        `host-${id.slice(0, 4)}`,
        fields.status ?? "active",
        fields.snapshot === undefined ? "a".repeat(64) : fields.snapshot,
        fields.retentionAt ?? null,
        fields.checkAt ?? null,
      ],
    );
    return id;
  }

  async function sampled(id: string, snapshot: string): Promise<void> {
    const [run] = await q<{ id: string }>(
      `INSERT INTO endpoint_runs (tenant_id, endpoint_id, kind, status, started_at, snapshot_id)
       VALUES ($1, $2, 'backup', 'succeeded', now(), $3) RETURNING id`,
      [tenantId, id, snapshot],
    );
    await q(
      `INSERT INTO endpoint_samples (tenant_id, endpoint_id, run_id, snapshot_id, path, sha256, size)
       VALUES ($1, $2, $3, $4, '/etc/hosts', $5, 5)`,
      [tenantId, id, run?.id, snapshot, "b".repeat(64)],
    );
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
    // The forced DROP DATABASE in afterAll waits for these connections to close
    // (testing/database.ts); one it still terminates surfaces as an "error"
    // event on its ended pool (for pg-boss, on the PgBoss instance) and would
    // fail the run although every test passed. Only that termination is
    // ignored; any other error is rethrown, and a failing query still rejects
    // its own promise.
    for (const db of [owner, provider]) {
      db.$client.on("error", ignoreTerminatedConnection);
    }
    boss = new PgBoss({ connectionString: urlFor(base, installationLogin) });
    boss.on("error", ignoreTerminatedConnection);
    await boss.start();
    for (const options of Object.values(ENDPOINT_QUEUE_OPTIONS)) {
      await boss.createQueue(options.name, options);
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
    await boss?.stop({ graceful: false, wait: true }).catch(() => undefined);
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

  it("names the four queues and creates them with the shared settings", () => {
    expect(Object.values(ENDPOINT_QUEUES)).toEqual([
      "endpoint-retention",
      "endpoint-check",
      "endpoint-verify",
      "endpoint-monitor",
    ]);
    expect(Object.keys(ENDPOINT_QUEUE_OPTIONS).sort()).toEqual(
      Object.values(ENDPOINT_QUEUES).sort(),
    );
  });

  it("finds retention due daily, per endpoint, for active endpoints of active tenants only", async () => {
    const planner = new EndpointJobPlanner({ installation: provider.$client }, boss);
    const never = await endpoint({});
    const old = await endpoint({ retentionAt: new Date(now.getTime() - 2 * DAY) });
    const fresh = await endpoint({ retentionAt: new Date(now.getTime() - HOUR) });
    const revoked = await endpoint({ status: "revoked" });
    const noBackup = await endpoint({ snapshot: null });
    const suspended = await endpoint({ tenant: suspendedTenantId });
    const due = (await planner.due(now)).retention.map((row) => row.id);
    expect(due).toContain(never);
    expect(due).toContain(old);
    expect(due).not.toContain(fresh);
    expect(due).not.toContain(revoked);
    expect(due).not.toContain(noBackup);
    expect(due).not.toContain(suspended);
  });

  it("finds the weekly check due, also for a revoked endpoint (its backups are still backups)", async () => {
    const planner = new EndpointJobPlanner({ installation: provider.$client }, boss);
    const overdue = await endpoint({ checkAt: new Date(now.getTime() - 8 * DAY) });
    const recent = await endpoint({ checkAt: new Date(now.getTime() - 2 * DAY) });
    const revoked = await endpoint({ status: "revoked", checkAt: null });
    const due = (await planner.due(now)).check.map((row) => row.id);
    expect(due).toContain(overdue);
    expect(due).not.toContain(recent);
    expect(due).toContain(revoked);
  });

  it("finds a restore test due for a new backup with samples and no server-side test yet", async () => {
    const planner = new EndpointJobPlanner({ installation: provider.$client }, boss);
    const snapshot = "c".repeat(64);
    const ready = await endpoint({ snapshot });
    await sampled(ready, snapshot);
    const tested = await endpoint({ snapshot });
    await sampled(tested, snapshot);
    await q(
      `INSERT INTO endpoint_reports (tenant_id, endpoint_id, kind, origin, snapshot_id, readiness)
       VALUES ($1, $2, 'restore_test', 'server', $3, 'red')`,
      [tenantId, tested, snapshot],
    );
    const withoutSamples = await endpoint({ snapshot });
    // A test of an older snapshot does not count for the new one.
    const newer = await endpoint({ snapshot });
    await sampled(newer, snapshot);
    await q(
      `INSERT INTO endpoint_reports (tenant_id, endpoint_id, kind, origin, snapshot_id, readiness)
       VALUES ($1, $2, 'restore_test', 'server', $3, 'green')`,
      [tenantId, newer, "d".repeat(64)],
    );
    // Only the agent tested it: the server still has to.
    const agentOnly = await endpoint({ snapshot });
    await sampled(agentOnly, snapshot);
    await q(
      `INSERT INTO endpoint_reports (tenant_id, endpoint_id, kind, origin, snapshot_id, readiness)
       VALUES ($1, $2, 'restore_test', 'agent', $3, 'green')`,
      [tenantId, agentOnly, snapshot],
    );
    const due = (await planner.due(now)).verify.map((row) => row.id);
    expect(due).toContain(ready);
    expect(due).toContain(newer);
    expect(due).toContain(agentOnly);
    expect(due).not.toContain(tested);
    expect(due).not.toContain(withoutSamples);
  });

  it("queues one job per endpoint and kind, spaced out, and the monitor every few minutes", async () => {
    const sent: { queue: string; data: unknown; options: PgBoss.SendOptions }[] = [];
    const recorder = {
      send: async (queue: string, data: object, options: PgBoss.SendOptions) => {
        sent.push({ queue, data, options });
        return randomUUID();
      },
    } as unknown as PgBoss;
    const planner = new EndpointJobPlanner({ installation: provider.$client }, recorder, 60_000);
    const id = await endpoint({});
    const counts = await planner.plan(now);
    expect(counts?.retention).toBeGreaterThan(0);
    const mine = sent.filter((entry) => (entry.data as { endpointId?: string }).endpointId === id);
    expect(mine.map((entry) => entry.queue).sort()).toEqual([
      "endpoint-check",
      "endpoint-retention",
    ]);
    for (const entry of mine) {
      expect(entry.options.singletonKey).toBe(`${entry.queue}:${id}`);
      expect(entry.options.singletonSeconds).toBe(3600);
      expect(entry.data).toEqual({ tenantId, endpointId: id });
    }
    const monitor = sent.filter((entry) => entry.queue === "endpoint-monitor");
    expect(monitor).toHaveLength(1);
    expect(monitor[0]?.options.singletonKey).toBe("endpoint-monitor");

    // A second pass within the interval does nothing.
    const before = sent.length;
    expect(await planner.plan(new Date(now.getTime() + 10_000))).toBeNull();
    expect(sent.length).toBe(before);
  });

  it("does not queue the same job twice with the real pg-boss", async () => {
    const planner = new EndpointJobPlanner({ installation: provider.$client }, boss, 0);
    const id = await endpoint({});
    await planner.plan(now);
    await planner.plan(new Date(now.getTime() + 1000));
    const rows = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pgboss.job
        WHERE name = 'endpoint-retention' AND data->>'endpointId' = $1`,
      [id],
    );
    expect(rows[0]?.n).toBe(1);
  });
});
