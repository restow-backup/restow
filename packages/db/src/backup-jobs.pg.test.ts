/**
 * The backup job model against a real Postgres, connected as the application role (the one Row
 * Level Security binds): isolation of `backup_jobs` and `backup_job_members` between tenants, the
 * constraints that keep the model honest (one `all` job per tenant and kind, a name once per
 * tenant and kind, a member of exactly one job, a member row that names exactly one target), the
 * cascade from a job to its members, and `schedules.superseded_by_job_id` surviving the deletion
 * of the job it points at (deleting a job must never revive the schedule it replaced).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (a scratch
 * database and two roles are created and dropped). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import type { RoleLogin } from "./roles.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;

const suffix = randomBytes(4).toString("hex");
const DATABASE = `restow_db_jobs_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_jobs_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_jobs_provider_${suffix}`,
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

async function inTransaction<T>(
  pool: pg.Pool,
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const SCHEDULE = JSON.stringify({ kind: "interval", intervalMinutes: 480, timeZone: "UTC" });

describe.skipIf(!adminUrl)("backup jobs against Postgres", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const contoso = randomUUID();
  const fabrikam = randomUUID();
  const mailbox = randomUUID();
  const otherMailbox = randomUUID();
  const machine = randomUUID();

  async function insertJob(
    pool: pg.Pool,
    tenantId: string,
    values: { name: string; kind?: string; scope?: string },
  ): Promise<string> {
    const id = randomUUID();
    await inTransaction(pool, tenantId, (client) =>
      client.query(
        `INSERT INTO backup_jobs (id, tenant_id, kind, name, scope_mode, schedule)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenantId, values.kind ?? "mail", values.name, values.scope ?? "selected", SCHEDULE],
      ),
    );
    return id;
  }

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
    const [providerRow] = (
      await owner.query<{ id: string }>(
        "INSERT INTO providers (name) VALUES ('Provider') RETURNING id",
      )
    ).rows;
    for (const [id, slug] of [
      [contoso, `contoso-${suffix}`],
      [fabrikam, `fabrikam-${suffix}`],
    ] as const) {
      await owner.query(
        "INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)",
        [id, providerRow?.id, slug],
      );
    }
    const [source] = (
      await owner.query<{ id: string }>(
        "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'm365', 'M365', 'active') RETURNING id",
        [contoso],
      )
    ).rows;
    for (const id of [mailbox, otherMailbox]) {
      await owner.query(
        `INSERT INTO protected_objects (id, tenant_id, source_id, kind, external_id)
         VALUES ($1, $2, $3, 'mailbox', $4)`,
        [id, contoso, source?.id, `${id}@contoso.example`],
      );
    }
    await owner.query(
      `INSERT INTO endpoints (id, tenant_id, hostname, os, arch, profile, secret_hash, config)
       VALUES ($1, $2, 'web01', 'linux', 'amd64', 'server', 'x', '{}'::jsonb)`,
      [machine, contoso],
    );
    app = new pg.Pool({ connectionString: urlFor(base, DATABASE, tenantLogin) });
  });

  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
    if (!adminUrl) {
      return;
    }
    await dropTestDatabase(adminUrl, DATABASE);
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`DROP ROLE IF EXISTS ${tenantLogin.name}`);
      await admin.query(`DROP ROLE IF EXISTS ${installationLogin.name}`);
    } finally {
      await admin.end();
    }
  });

  it("isolates jobs and members between tenants", async () => {
    const own = await insertJob(app, contoso, { name: "Mail backup" });
    await insertJob(app, fabrikam, { name: "Foreign job" });
    await inTransaction(app, contoso, (client) =>
      client.query(
        "INSERT INTO backup_job_members (tenant_id, job_id, protected_object_id) VALUES ($1, $2, $3)",
        [contoso, own, mailbox],
      ),
    );
    const seen = await inTransaction(app, contoso, async (client) => ({
      jobs: (await client.query<{ name: string }>("SELECT name FROM backup_jobs")).rows.map(
        (row) => row.name,
      ),
      members: (await client.query("SELECT id FROM backup_job_members")).rowCount,
      foreign: (await client.query("SELECT id FROM backup_jobs WHERE tenant_id = $1", [fabrikam]))
        .rowCount,
    }));
    expect(seen).toEqual({ jobs: ["Mail backup"], members: 1, foreign: 0 });
    const unpinned = await inTransaction(app, null, async (client) => ({
      jobs: (await client.query("SELECT id FROM backup_jobs")).rowCount,
      members: (await client.query("SELECT id FROM backup_job_members")).rowCount,
    }));
    expect(unpinned).toEqual({ jobs: 0, members: 0 });
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          "INSERT INTO backup_jobs (tenant_id, kind, name, schedule) VALUES ($1, 'mail', 'smuggled', $2)",
          [fabrikam, SCHEDULE],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("allows one job covering all objects per tenant and kind, and a name once per kind", async () => {
    await insertJob(app, contoso, { name: "All mail", scope: "all" });
    await expect(insertJob(app, contoso, { name: "Another all", scope: "all" })).rejects.toThrow(
      /backup_jobs_tenant_kind_all_uq/,
    );
    // Another tenant, and another kind, are separate.
    await insertJob(app, fabrikam, { name: "All mail", scope: "all" });
    await insertJob(app, contoso, { name: "All machines", kind: "endpoint", scope: "all" });
    await expect(insertJob(app, contoso, { name: "all MAIL" })).rejects.toThrow(
      /backup_jobs_tenant_kind_name_uq/,
    );
    // The same name for a machine job is fine.
    await insertJob(app, contoso, { name: "ALL mail", kind: "endpoint" });
  });

  it("puts an object or a machine in at most one job and names exactly one target", async () => {
    const first = await insertJob(app, contoso, { name: "First" });
    const second = await insertJob(app, contoso, { name: "Second" });
    await inTransaction(app, contoso, (client) =>
      client.query(
        "INSERT INTO backup_job_members (tenant_id, job_id, protected_object_id) VALUES ($1, $2, $3)",
        [contoso, first, otherMailbox],
      ),
    );
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          "INSERT INTO backup_job_members (tenant_id, job_id, protected_object_id) VALUES ($1, $2, $3)",
          [contoso, second, otherMailbox],
        ),
      ),
    ).rejects.toThrow(/backup_job_members_object_uq/);

    const machines = await insertJob(app, contoso, { name: "Servers", kind: "endpoint" });
    const others = await insertJob(app, contoso, { name: "Others", kind: "endpoint" });
    await inTransaction(app, contoso, (client) =>
      client.query(
        "INSERT INTO backup_job_members (tenant_id, job_id, endpoint_id) VALUES ($1, $2, $3)",
        [contoso, machines, machine],
      ),
    );
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          "INSERT INTO backup_job_members (tenant_id, job_id, endpoint_id) VALUES ($1, $2, $3)",
          [contoso, others, machine],
        ),
      ),
    ).rejects.toThrow(/backup_job_members_endpoint_uq/);

    await expect(
      inTransaction(app, contoso, (client) =>
        client.query("INSERT INTO backup_job_members (tenant_id, job_id) VALUES ($1, $2)", [
          contoso,
          first,
        ]),
      ),
    ).rejects.toThrow(/backup_job_members_one_target_ck/);
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          "INSERT INTO backup_job_members (tenant_id, job_id, protected_object_id, endpoint_id) VALUES ($1, $2, $3, $4)",
          [contoso, first, mailbox, machine],
        ),
      ),
    ).rejects.toThrow(/backup_job_members_one_target_ck/);
  });

  it("removes the members with their job and keeps the schedule the job replaced replaced", async () => {
    const job = await insertJob(app, contoso, { name: "Replacing job" });
    const object = randomUUID();
    const [source] = (
      await owner.query<{ id: string }>("SELECT id FROM sources WHERE tenant_id = $1", [contoso])
    ).rows;
    await owner.query(
      `INSERT INTO protected_objects (id, tenant_id, source_id, kind, external_id)
       VALUES ($1, $2, $3, 'mailbox', 'cascade@contoso.example')`,
      [object, contoso, source?.id],
    );
    await inTransaction(app, contoso, async (client) => {
      await client.query(
        "INSERT INTO backup_job_members (tenant_id, job_id, protected_object_id) VALUES ($1, $2, $3)",
        [contoso, job, object],
      );
    });
    const [schedule] = (
      await owner.query<{ id: string }>(
        `INSERT INTO schedules (tenant_id, kind, interval_minutes, timezone, superseded_by_job_id)
         VALUES ($1, 'backup', 480, 'UTC', $2) RETURNING id`,
        [contoso, job],
      )
    ).rows;
    await inTransaction(app, contoso, (client) =>
      client.query("DELETE FROM backup_jobs WHERE id = $1", [job]),
    );
    const members = await owner.query("SELECT id FROM backup_job_members WHERE job_id = $1", [job]);
    expect(members.rowCount).toBe(0);
    const kept = await owner.query<{ superseded_by_job_id: string | null }>(
      "SELECT superseded_by_job_id FROM schedules WHERE id = $1",
      [schedule?.id],
    );
    expect(kept.rows[0]?.superseded_by_job_id).toBe(job);
  });

  it("carries the migration marker on tenants, empty until a tenant was moved", async () => {
    const { rows } = await owner.query<{ backup_jobs_migrated_at: Date | null }>(
      "SELECT backup_jobs_migrated_at FROM tenants WHERE id = $1",
      [contoso],
    );
    expect(rows[0]?.backup_jobs_migrated_at).toBeNull();
  });
});
