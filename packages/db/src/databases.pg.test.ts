/**
 * The tables of the module "Databases" against a real Postgres, connected as the application role
 * (docs/DATABASES.md 9): tenant A never sees or writes B's connections, databases or tests; the
 * checks keep what the design says (the server executor opens PostgreSQL, MySQL and MariaDB with a
 * password only, an SQLite file has a path and no host); a name is unique per tenant; a database
 * dropped and created again under its name is another row; deleting a connection takes its
 * databases and tests along, and a gone machine leaves the connection without an executor.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser; skipped otherwise.
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import type { RoleLogin } from "./roles.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const DATABASE = `restow_db_databases_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_dbm_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_dbm_provider_${suffix}`,
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

async function inTenant<T>(
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

const SCHEDULE = JSON.stringify({
  kind: "interval",
  intervalMinutes: 60,
  timeZone: "Europe/Berlin",
});

describe.skipIf(!adminUrl)("database module tables against Postgres", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  const contoso = randomUUID();
  const fabrikam = randomUUID();

  async function seed(
    tenantId: string,
    name: string,
  ): Promise<{ connection: string; endpoint: string }> {
    return inTenant(app, tenantId, async (client) => {
      const endpoint = (
        await client.query<{ id: string }>(
          `INSERT INTO endpoints (tenant_id, hostname, os, arch, profile, secret_hash, config)
           VALUES ($1, $2, 'linux', 'amd64', 'server', 'x', '{}'::jsonb) RETURNING id`,
          [tenantId, `db-${name}`],
        )
      ).rows[0]?.id as string;
      const connection = (
        await client.query<{ id: string }>(
          `INSERT INTO database_connections (tenant_id, name, engine, host, port, executor_kind, executor_endpoint_id, schedule)
           VALUES ($1, $2, 'postgresql', 'db.example.test', 5432, 'agent', $3, $4::jsonb) RETURNING id`,
          [tenantId, name, endpoint, SCHEDULE],
        )
      ).rows[0]?.id as string;
      await client.query(
        "INSERT INTO databases (tenant_id, connection_id, name, identity) VALUES ($1, $2, 'app', '16384')",
        [tenantId, connection],
      );
      await client.query(
        `INSERT INTO database_probes (tenant_id, connection_id, executor_kind, executor_endpoint_id, spec, expires_at)
         VALUES ($1, $2, 'agent', $3, '{}'::jsonb, now() + interval '10 minutes')`,
        [tenantId, connection, endpoint],
      );
      return { connection, endpoint };
    });
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
    const provider = (
      await owner.query<{ id: string }>("INSERT INTO providers (name) VALUES ('P') RETURNING id")
    ).rows[0]?.id;
    for (const [id, slug] of [
      [contoso, `contoso-${suffix}`],
      [fabrikam, `fabrikam-${suffix}`],
    ]) {
      await owner.query(
        "INSERT INTO tenants (id, provider_id, name, slug) VALUES ($1, $2, $3, $3)",
        [id, provider, slug],
      );
    }
    app = new pg.Pool({ connectionString: urlFor(base, DATABASE, tenantLogin) });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
    await dropTestDatabase(adminUrl as string, DATABASE);
    const admin = new pg.Pool({ connectionString: adminUrl as string });
    try {
      for (const role of [tenantLogin.name, installationLogin.name]) {
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
      }
    } finally {
      await admin.end();
    }
  });

  it("keeps connections, databases and tests inside their tenant", async () => {
    await seed(contoso, "Contoso ERP");
    await seed(fabrikam, "Fabrikam ERP");
    for (const table of ["database_connections", "databases", "database_probes"]) {
      const own = await inTenant(app, contoso, (client) =>
        client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${table}`),
      );
      expect(own.rows.length, table).toBeGreaterThan(0);
      expect(
        own.rows.every((row) => row.tenant_id === contoso),
        table,
      ).toBe(true);
      const unpinned = await inTenant(app, null, (client) =>
        client.query(`SELECT 1 FROM ${table}`),
      );
      expect(unpinned.rows, table).toEqual([]);
    }
    await expect(
      inTenant(app, contoso, (client) =>
        client.query(
          `INSERT INTO database_connections (tenant_id, name, engine, host, executor_kind, schedule)
           VALUES ($1, 'x', 'postgresql', 'h', 'server', $2::jsonb)`,
          [fabrikam, SCHEDULE],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("keeps the rules of executors and addresses", async () => {
    const insert = (values: string) =>
      inTenant(app, contoso, (client) =>
        client.query(
          `INSERT INTO database_connections (tenant_id, name, engine, host, path, executor_kind, auth_method, schedule)
           VALUES ($1, ${values}, $2::jsonb)`,
          [contoso, SCHEDULE],
        ),
      );
    // The server opens no SQLite file, no SQL Server and never signs in over the socket.
    await expect(
      insert("'a', 'sqlite', NULL, '/var/lib/a.db', 'server', 'password'"),
    ).rejects.toThrow(/database_connections_server_ck/);
    await expect(insert("'b', 'sqlserver', 'sql01', NULL, 'server', 'password'")).rejects.toThrow(
      /database_connections_server_ck/,
    );
    await expect(insert("'c', 'mysql', 'db', NULL, 'server', 'socket'")).rejects.toThrow(
      /database_connections_server_ck/,
    );
    // An SQLite file has a path and no host.
    await expect(insert("'d', 'sqlite', 'host', NULL, 'agent', 'password'")).rejects.toThrow(
      /database_connections_address_ck/,
    );
    await expect(insert("'e', 'oracle', 'db', NULL, 'agent', 'password'")).rejects.toThrow(
      /database_connections_engine_ck/,
    );
    await insert("'f', 'sqlite', NULL, '/var/lib/f.db', 'agent', 'socket'");
    // The name is unique per tenant, whatever its case.
    await expect(
      insert("'CONTOSO erp', 'mysql', 'db', NULL, 'server', 'password'"),
    ).rejects.toThrow(/database_connections_tenant_name_uq/);
  });

  it("keeps a database created again under its name as another row, and cascades", async () => {
    const { connection, endpoint } = await seed(contoso, "Contoso shop");
    const insert = (name: string, identity: string | null) =>
      inTenant(app, contoso, (client) =>
        client.query(
          "INSERT INTO databases (tenant_id, connection_id, name, identity) VALUES ($1, $2, $3, $4)",
          [contoso, connection, name, identity],
        ),
      );
    // Dropped and created again: another OID, another row; the same OID twice is refused.
    await insert("app", "20001");
    await expect(insert("app", "20001")).rejects.toThrow(/databases_connection_name_identity_uq/);
    // A schema without a stable id (MySQL) is known by its name once.
    await insert("shop", null);
    await expect(insert("shop", null)).rejects.toThrow(/databases_connection_name_identity_uq/);
    const count = await inTenant(app, contoso, (client) =>
      client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM databases WHERE connection_id = $1",
        [connection],
      ),
    );
    expect(count.rows[0]?.n).toBe(3);
    // A machine that is deleted leaves the connection without an executor; its tests go with it.
    await inTenant(app, contoso, (client) =>
      client.query("DELETE FROM endpoints WHERE id = $1", [endpoint]),
    );
    const after = await inTenant(app, contoso, (client) =>
      client.query<{ executor_endpoint_id: string | null; probes: number }>(
        `SELECT executor_endpoint_id,
                (SELECT count(*)::int FROM database_probes WHERE connection_id = $1) AS probes
           FROM database_connections WHERE id = $1`,
        [connection],
      ),
    );
    expect(after.rows).toEqual([{ executor_endpoint_id: null, probes: 0 }]);
    await inTenant(app, contoso, (client) =>
      client.query("DELETE FROM database_connections WHERE id = $1", [connection]),
    );
    const left = await inTenant(app, contoso, (client) =>
      client.query("SELECT 1 FROM databases WHERE connection_id = $1", [connection]),
    );
    expect(left.rows).toEqual([]);
  });

  it("drops the sealed credentials of a test with the test and with its machine", async () => {
    const { connection, endpoint } = await seed(contoso, "Contoso Probes");
    const probeWithSecret = (status: string, endpointId: string | null = endpoint) =>
      inTenant(app, contoso, async (client) => {
        const secret = (
          await client.query<{ id: string }>(
            `INSERT INTO secrets (tenant_id, kind, ciphertext)
             VALUES ($1, 'database_probe_credentials', 'sealed-fixture') RETURNING id`,
            [contoso],
          )
        ).rows[0]?.id as string;
        const probe = (
          await client.query<{ id: string }>(
            `INSERT INTO database_probes (tenant_id, connection_id, executor_kind, executor_endpoint_id, spec, credential_secret_id, status, expires_at)
             VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, now() + interval '10 minutes') RETURNING id`,
            [contoso, connection, endpointId ? "agent" : "server", endpointId, secret, status],
          )
        ).rows[0]?.id as string;
        return { secret, probe };
      });
    const secretExists = (id: string) =>
      inTenant(app, contoso, async (client) =>
        Boolean((await client.query("SELECT 1 FROM secrets WHERE id = $1", [id])).rows.length),
      );

    // A deleted test takes its credentials along.
    const deleted = await probeWithSecret("done", null);
    await inTenant(app, contoso, (client) =>
      client.query("DELETE FROM database_probes WHERE id = $1", [deleted.probe]),
    );
    expect(await secretExists(deleted.secret)).toBe(false);

    // A revoked machine ends its open tests and drops their credentials at once.
    const pending = await probeWithSecret("pending");
    const finished = await probeWithSecret("done");
    await inTenant(app, contoso, (client) =>
      client.query("UPDATE endpoints SET status = 'revoked', revoked_at = now() WHERE id = $1", [
        endpoint,
      ]),
    );
    expect(await secretExists(pending.secret)).toBe(false);
    expect(await secretExists(finished.secret)).toBe(false);
    const states = await inTenant(app, contoso, (client) =>
      client.query<{ id: string; status: string; credential_secret_id: string | null }>(
        "SELECT id, status, credential_secret_id FROM database_probes WHERE id = ANY($1::uuid[])",
        [[pending.probe, finished.probe]],
      ),
    );
    expect(Object.fromEntries(states.rows.map((row) => [row.id, row]))).toMatchObject({
      [pending.probe]: { status: "expired", credential_secret_id: null },
      [finished.probe]: { status: "done", credential_secret_id: null },
    });

    // A machine deleted outright: its tests go by the cascade, their credentials with them.
    const other = await seed(contoso, "Contoso Probes 2");
    const cascaded = await probeWithSecret("pending", other.endpoint);
    await inTenant(app, contoso, (client) =>
      client.query("DELETE FROM endpoints WHERE id = $1", [other.endpoint]),
    );
    expect(await secretExists(cascaded.secret)).toBe(false);
  });
});
