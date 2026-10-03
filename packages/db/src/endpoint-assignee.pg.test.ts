/**
 * The person a machine is assigned to (`endpoints.assigned_user_id`, migration 0025) against a
 * real Postgres, connected as the application role (the one Row Level Security binds):
 *
 *   - a machine takes a person of its own tenant's directory,
 *   - a person of another tenant is refused by the database itself, by the application role
 *     (which cannot even see that person) and by the owner (which bypasses Row Level Security:
 *     the key over (tenant_id, assigned_user_id) refuses it),
 *   - the assignment is visible only inside the machine's tenant,
 *   - a person leaving the directory clears the assignment and nothing else (the machine keeps
 *     its tenant).
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
const DATABASE = `restow_db_assignee_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_assignee_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_assignee_provider_${suffix}`,
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

const CONFIG = JSON.stringify({
  profile: "client",
  schedule: { kind: "none", timeZone: "UTC" },
  paths: ["/home"],
  excludes: [],
  hooks: {},
  bandwidthKbps: null,
  onlyOnAcPower: false,
  useVss: false,
});

describe.skipIf(!adminUrl)("endpoint assignment against Postgres", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const contoso = randomUUID();
  const fabrikam = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const mallory = randomUUID();
  const laptop = randomUUID();

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
    for (const [id, tenantId, email] of [
      [alice, contoso, "alice@contoso.example"],
      [bob, contoso, "bob@contoso.example"],
      [mallory, fabrikam, "mallory@fabrikam.example"],
    ] as const) {
      await owner.query(
        "INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, $3)",
        [id, tenantId, email],
      );
    }
    await owner.query(
      `INSERT INTO endpoints (id, tenant_id, hostname, os, arch, profile, secret_hash, config)
       VALUES ($1, $2, 'laptop-01', 'linux', 'amd64', 'client', 'hash', $3)`,
      [laptop, contoso, CONFIG],
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

  const assignedOf = async (tenantId: string) =>
    inTransaction(app, tenantId, async (client) =>
      (
        await client.query<{ assigned_user_id: string | null }>(
          "SELECT assigned_user_id FROM endpoints WHERE id = $1",
          [laptop],
        )
      ).rows.map((row) => row.assigned_user_id),
    );

  it("assigns a machine to a person of its own tenant", async () => {
    await inTransaction(app, contoso, (client) =>
      client.query("UPDATE endpoints SET assigned_user_id = $1 WHERE id = $2", [alice, laptop]),
    );
    expect(await assignedOf(contoso)).toEqual([alice]);
  });

  it("refuses a person of another tenant, to the application role and to the owner", async () => {
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query("UPDATE endpoints SET assigned_user_id = $1 WHERE id = $2", [mallory, laptop]),
      ),
    ).rejects.toThrow(/foreign key/);
    // The owner bypasses Row Level Security; the key over (tenant_id, assigned_user_id) still holds.
    await expect(
      owner.query("UPDATE endpoints SET assigned_user_id = $1 WHERE id = $2", [mallory, laptop]),
    ).rejects.toThrow(/endpoints_assigned_user_tenant_fk/);
    expect(await assignedOf(contoso)).toEqual([alice]);
  });

  it("shows the assignment only inside the machine's tenant", async () => {
    expect(await assignedOf(fabrikam)).toEqual([]);
    const moved = await inTransaction(app, fabrikam, (client) =>
      client.query("UPDATE endpoints SET assigned_user_id = $1 WHERE id = $2", [mallory, laptop]),
    );
    expect(moved.rowCount).toBe(0);
    expect(await assignedOf(contoso)).toEqual([alice]);
  });

  it("clears only the assignment when the person leaves the directory", async () => {
    await inTransaction(app, contoso, (client) =>
      client.query("DELETE FROM users WHERE id = $1", [alice]),
    );
    const [row] = (
      await owner.query<{ tenant_id: string; assigned_user_id: string | null }>(
        "SELECT tenant_id, assigned_user_id FROM endpoints WHERE id = $1",
        [laptop],
      )
    ).rows;
    expect(row).toEqual({ tenant_id: contoso, assigned_user_id: null });
    // Another person of the tenant can take the machine.
    await inTransaction(app, contoso, (client) =>
      client.query("UPDATE endpoints SET assigned_user_id = $1 WHERE id = $2", [bob, laptop]),
    );
    expect(await assignedOf(contoso)).toEqual([bob]);
  });
});
