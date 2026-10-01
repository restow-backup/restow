/**
 * Row Level Security as the application actually runs it: connected as the
 * provisioned application role, not as the owner.
 *
 * The migration step provisions two login roles next to the owner. This suite
 * migrates a scratch database with them, writes two tenants as the owner and
 * then proves, connected as each role, that
 *
 *   - the application role is neither superuser nor BYPASSRLS and owns nothing,
 *   - an unpinned transaction on it sees no tenant row at all,
 *   - a transaction pinned to tenant A sees A's rows and none of B's, and cannot
 *     write a row for B,
 *   - it cannot rewrite the audit log,
 *   - both roles keep the installation-level service heartbeats (never with an
 *     IP address as host name) and the application role the auth rate-limit
 *     counters, without a pinned tenant,
 *   - a verification report and its snapshot link stay inside the tenant, and
 *     one Entra identity belongs to at most one user,
 *   - the installation role sees every tenant, which is what the lookups made
 *     before a tenant is known rely on,
 *   - a pg-boss schema created earlier by the owner is handed to the
 *     installation role, and the application role may enqueue into it.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser
 * (roles are cluster-wide: the suite creates uniquely named ones and drops them
 * again). Without it the suite is skipped; docs/TESTING.md lists it under
 * integration.
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { type RoleLogin, assertDatabaseRoles, inspectCurrentRole, roleProblems } from "./roles.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;

const suffix = randomBytes(4).toString("hex");
const DATABASE = `restow_db_rls_test_${suffix}`;
const tenantLogin: RoleLogin = {
  name: `restow_rls_app_${suffix}`,
  password: randomBytes(18).toString("base64url"),
};
const installationLogin: RoleLogin = {
  name: `restow_rls_provider_${suffix}`,
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

/** Run `fn` in a transaction, pinned to `tenantId` when one is given. */
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

describe.skipIf(!adminUrl)("Row Level Security on the application role", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let provider: pg.Pool;
  const contoso = randomUUID();
  const fabrikam = randomUUID();

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
    // A pg-boss schema from before the role split, owned by the database owner.
    await owner.query("CREATE SCHEMA pgboss");
    await owner.query("CREATE TABLE pgboss.job (id uuid PRIMARY KEY, name text NOT NULL)");

    await runMigrations(ownerUrl, {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });
    // Idempotent: a second run (the next deploy) changes nothing and fails nothing.
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
      await owner.query(
        "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'm365', $2, 'active')",
        [id, `${slug} M365`],
      );
    }

    app = new pg.Pool({ connectionString: urlFor(base, DATABASE, tenantLogin) });
    provider = new pg.Pool({ connectionString: urlFor(base, DATABASE, installationLogin) });
  });

  afterAll(async () => {
    await Promise.all([app?.end(), provider?.end(), owner?.end()]);
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

  it("provisions an application role that cannot get around the policies", async () => {
    const roles = await assertDatabaseRoles({ tenant: app, installation: provider });
    expect(roleProblems("tenant", roles.tenant)).toEqual([]);
    expect(roles.tenant).toMatchObject({ superuser: false, bypassRls: false, ownsTables: false });
    expect(roles.installation).toMatchObject({ superuser: false, bypassRls: true });
    await expect(assertDatabaseRoles({ tenant: owner, installation: provider })).rejects.toThrow(
      /DATABASE_URL/,
    );
  });

  it("shows an unpinned transaction no tenant rows", async () => {
    const rows = await inTransaction(app, null, async (client) => ({
      tenants: (await client.query("SELECT id FROM tenants")).rowCount,
      sources: (await client.query("SELECT id FROM sources")).rowCount,
    }));
    expect(rows).toEqual({ tenants: 0, sources: 0 });
  });

  it("confines a pinned transaction to its own tenant", async () => {
    const seen = await inTransaction(app, contoso, async (client) => ({
      tenants: (await client.query<{ id: string }>("SELECT id FROM tenants")).rows.map((r) => r.id),
      sources: (await client.query<{ tenant_id: string }>("SELECT tenant_id FROM sources")).rows,
      // Even naming the other tenant explicitly finds nothing.
      other: (await client.query("SELECT id FROM sources WHERE tenant_id = $1", [fabrikam]))
        .rowCount,
    }));
    expect(seen.tenants).toEqual([contoso]);
    expect(seen.sources.map((row) => row.tenant_id)).toEqual([contoso]);
    expect(seen.other).toBe(0);
  });

  it("refuses to write a row for another tenant", async () => {
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          "INSERT INTO sources (tenant_id, kind, name) VALUES ($1, 'imap', 'smuggled')",
          [fabrikam],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const moved = await inTransaction(app, contoso, (client) =>
      client.query("UPDATE sources SET tenant_id = $1 WHERE tenant_id = $2", [fabrikam, contoso]),
    ).catch((error: Error) => error);
    expect(moved).toBeInstanceOf(Error);
  });

  it("cannot rewrite the audit log", async () => {
    await expect(
      inTransaction(app, contoso, (client) => client.query("DELETE FROM audit_log")),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets the installation role see every tenant", async () => {
    const { rows } = await provider.query<{ id: string }>("SELECT id FROM tenants ORDER BY slug");
    expect(rows.map((row) => row.id)).toEqual([contoso, fabrikam]);
    expect((await inspectCurrentRole(provider)).name).toBe(installationLogin.name);
  });

  it("lets both roles keep the service heartbeats, outside any tenant", async () => {
    const instanceId = `worker-${suffix}`;
    const beat = (pool: pg.Pool, hostname: string | null) =>
      pool.query(
        `INSERT INTO service_heartbeats (role, instance_id, version, hostname, started_at)
         VALUES ('worker', $1, '0.301.0', $2, now())
         ON CONFLICT (instance_id) DO UPDATE SET beat_at = now(), hostname = EXCLUDED.hostname`,
        [instanceId, hostname],
      );
    // The application role writes without a pinned tenant: the table has no policy.
    await beat(app, "restow-worker-1");
    await beat(provider, "restow-worker-2");
    const seen = await inTransaction(app, contoso, (client) =>
      client.query<{ hostname: string }>(
        "SELECT hostname FROM service_heartbeats WHERE instance_id = $1",
        [instanceId],
      ),
    );
    expect(seen.rows).toEqual([{ hostname: "restow-worker-2" }]);
    // Container ids can be all digits; that is still a name.
    await beat(app, "123456789012");
    await beat(app, null);
    for (const address of ["10.0.0.7", "::1", "fe80::1%eth0", "::ffff:192.0.2.1"]) {
      await expect(beat(app, address), address).rejects.toThrow(
        /service_heartbeats_hostname_not_ip/,
      );
    }
    expect(
      (await provider.query("DELETE FROM service_heartbeats WHERE instance_id = $1", [instanceId]))
        .rowCount,
    ).toBe(1);
  });

  it("lets the application role keep the auth rate-limit counters", async () => {
    const key = `198.51.100.7|/sign-in/email|${suffix}`;
    await app.query(
      "INSERT INTO rate_limit (id, key, count, last_request) VALUES ($1, $2, 1, $3)",
      [randomUUID(), key, Date.now()],
    );
    await app.query("UPDATE rate_limit SET count = count + 1 WHERE key = $1", [key]);
    const { rows } = await app.query<{ count: number }>(
      "SELECT count FROM rate_limit WHERE key = $1",
      [key],
    );
    expect(rows).toEqual([{ count: 2 }]);
    await expect(
      app.query("INSERT INTO rate_limit (id, key, count, last_request) VALUES ($1, $2, 1, 0)", [
        randomUUID(),
        key,
      ]),
    ).rejects.toThrow(/rate_limit_key_unique/);
    expect((await app.query("DELETE FROM rate_limit WHERE key = $1", [key])).rowCount).toBe(1);
  });

  it("keeps a verification report and its snapshot link inside the tenant", async () => {
    const [object] = (
      await owner.query<{ id: string }>(
        `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id)
         SELECT tenant_id, id, 'mailbox', 'adele@contoso.test' FROM sources WHERE tenant_id = $1
         RETURNING id`,
        [contoso],
      )
    ).rows;
    const [snapshot] = (
      await owner.query<{ id: string }>(
        `INSERT INTO snapshots (tenant_id, protected_object_id, sequence)
         VALUES ($1, $2, 1) RETURNING id`,
        [contoso, object?.id],
      )
    ).rows;
    const [report] = (
      await inTransaction(app, contoso, (client) =>
        client.query<{ id: string }>(
          `INSERT INTO verify_reports (tenant_id, protected_object_id, snapshot_id, recovery_readiness)
           VALUES ($1, $2, $3, 'green') RETURNING id`,
          [contoso, object?.id, snapshot?.id],
        ),
      )
    ).rows;
    const reportsOf = (tenantId: string) =>
      inTransaction(app, tenantId, async (client) => {
        const { rows } = await client.query<{ snapshot_id: string | null }>(
          "SELECT snapshot_id FROM verify_reports WHERE id = $1",
          [report?.id],
        );
        return rows;
      });
    expect(await reportsOf(fabrikam)).toEqual([]);
    expect(await reportsOf(contoso)).toEqual([{ snapshot_id: snapshot?.id }]);
    // Pruning the snapshot keeps the report, unlinked.
    await inTransaction(app, contoso, (client) =>
      client.query("DELETE FROM snapshots WHERE id = $1", [snapshot?.id]),
    );
    expect(await reportsOf(contoso)).toEqual([{ snapshot_id: null }]);
  });

  it("proves another tenant cannot read or set a protected object's per-mailbox secret_ref", async () => {
    const [contosoSource] = (
      await owner.query<{ id: string }>("SELECT id FROM sources WHERE tenant_id = $1 LIMIT 1", [
        contoso,
      ])
    ).rows;
    const [secret] = (
      await owner.query<{ id: string }>(
        `INSERT INTO secrets (tenant_id, kind, ciphertext) VALUES ($1, 'imap_password', 'sealed-fixture')
         RETURNING id`,
        [contoso],
      )
    ).rows;
    const secretId = secret?.id ?? "";
    const [object] = (
      await owner.query<{ id: string }>(
        `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, secret_ref, credential_status)
         VALUES ($1, $2, 'imap', $3, $4, 'ok') RETURNING id`,
        [contoso, contosoSource?.id, `credentialed-${suffix}@contoso.test`, secretId],
      )
    ).rows;
    const objectId = object?.id ?? "";

    // Fabrikam cannot see the row at all, secret_ref included.
    const seenByFabrikam = await inTransaction(app, fabrikam, (client) =>
      client.query("SELECT id FROM protected_objects WHERE id = $1", [objectId]),
    );
    expect(seenByFabrikam.rowCount).toBe(0);

    // Nor can it change the reference: the row is invisible, so the UPDATE
    // matches nothing rather than erroring.
    const blockedUpdate = await inTransaction(app, fabrikam, (client) =>
      client.query("UPDATE protected_objects SET secret_ref = NULL WHERE id = $1", [objectId]),
    );
    expect(blockedUpdate.rowCount).toBe(0);

    // Contoso, the owning tenant, sees and can change it normally.
    const seenByContoso = await inTransaction(app, contoso, (client) =>
      client.query<{ secret_ref: string; credential_status: string }>(
        "SELECT secret_ref, credential_status FROM protected_objects WHERE id = $1",
        [objectId],
      ),
    );
    expect(seenByContoso.rows).toEqual([{ secret_ref: secretId, credential_status: "ok" }]);

    // Deleting the secret clears the reference, never the object.
    await owner.query("DELETE FROM secrets WHERE id = $1", [secretId]);
    const afterDelete = await inTransaction(app, contoso, (client) =>
      client.query<{ secret_ref: string | null }>(
        "SELECT secret_ref FROM protected_objects WHERE id = $1",
        [objectId],
      ),
    );
    expect(afterDelete.rows).toEqual([{ secret_ref: null }]);
  });

  it("isolates tenant contacts, notification recipients and storage migrations per tenant", async () => {
    // Destination targets the migrations below point at (any admin flow creates these first).
    const storageTarget = async (tenantId: string, name: string) =>
      (
        await owner.query<{ id: string }>(
          `INSERT INTO storage_targets (tenant_id, name, kind, role, config)
           VALUES ($1, $2, 'local', 'copy', '{"basePath":"/data/chunks"}'::jsonb)
           RETURNING id`,
          [tenantId, name],
        )
      ).rows[0]?.id;
    const contosoTarget = await storageTarget(contoso, `contoso-${suffix}-new`);
    const fabrikamTarget = await storageTarget(fabrikam, `fabrikam-${suffix}-new`);

    await inTransaction(app, contoso, (client) =>
      client.query(
        "INSERT INTO tenant_contacts (tenant_id, name, is_primary) VALUES ($1, 'Adele Vance', true)",
        [contoso],
      ),
    );
    await inTransaction(app, fabrikam, (client) =>
      client.query("INSERT INTO tenant_contacts (tenant_id, name) VALUES ($1, 'Megan Bowen')", [
        fabrikam,
      ]),
    );
    await inTransaction(app, contoso, (client) =>
      client.query(
        `INSERT INTO tenant_notification_recipients (tenant_id, email, notify_job_failures)
         VALUES ($1, $2, true)`,
        [contoso, `alerts-${suffix}@contoso.test`],
      ),
    );
    await inTransaction(app, contoso, (client) =>
      client.query(
        `INSERT INTO storage_migrations (tenant_id, destination_target_id, mode)
         VALUES ($1, $2, 'move')`,
        [contoso, contosoTarget],
      ),
    );
    await inTransaction(app, fabrikam, (client) =>
      client.query(
        `INSERT INTO storage_migrations (tenant_id, destination_target_id, mode)
         VALUES ($1, $2, 'keep')`,
        [fabrikam, fabrikamTarget],
      ),
    );

    const seenBy = (tenantId: string) =>
      inTransaction(app, tenantId, async (client) => ({
        contacts: (await client.query("SELECT id FROM tenant_contacts")).rowCount,
        recipients: (await client.query("SELECT id FROM tenant_notification_recipients")).rowCount,
        migrations: (await client.query("SELECT id FROM storage_migrations")).rowCount,
      }));
    expect(await seenBy(contoso)).toEqual({ contacts: 1, recipients: 1, migrations: 1 });
    expect(await seenBy(fabrikam)).toEqual({ contacts: 1, recipients: 0, migrations: 1 });

    // A second primary contact, or a second unfinished migration, for the same
    // tenant collides with the partial unique index.
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          "INSERT INTO tenant_contacts (tenant_id, name, is_primary) VALUES ($1, 'Alex Wilber', true)",
          [contoso],
        ),
      ),
    ).rejects.toThrow(/tenant_contacts_tenant_primary_uq/);
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          `INSERT INTO storage_migrations (tenant_id, destination_target_id, mode)
           VALUES ($1, $2, 'move')`,
          [contoso, contosoTarget],
        ),
      ),
    ).rejects.toThrow(/storage_migrations_tenant_unfinished_uq/);

    // The installation role sees every tenant here too, exactly like it does for `tenants`.
    const totalOf = async (table: string) =>
      Number(
        (await provider.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n,
      );
    expect(await totalOf("tenant_contacts")).toBe(2);
    expect(await totalOf("tenant_notification_recipients")).toBe(1);
    expect(await totalOf("storage_migrations")).toBe(2);

    // An unpinned transaction sees none of these rows, exactly like every other
    // tenant-scoped table.
    const unpinned = await inTransaction(app, null, async (client) => ({
      contacts: (await client.query("SELECT id FROM tenant_contacts")).rowCount,
      recipients: (await client.query("SELECT id FROM tenant_notification_recipients")).rowCount,
      migrations: (await client.query("SELECT id FROM storage_migrations")).rowCount,
    }));
    expect(unpinned).toEqual({ contacts: 0, recipients: 0, migrations: 0 });

    // A transaction pinned to contoso cannot smuggle a row in for another
    // tenant: WITH CHECK refuses it just like it does for `sources`. A tenant
    // id with no rows of its own (rather than fabrikam, which already has an
    // unfinished migration above) keeps this a pure RLS check, not a collision
    // with storage_migrations_tenant_unfinished_uq.
    const outsider = randomUUID();
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query("INSERT INTO tenant_contacts (tenant_id, name) VALUES ($1, 'Smuggled')", [
          outsider,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          "INSERT INTO tenant_notification_recipients (tenant_id, email) VALUES ($1, $2)",
          [outsider, `smuggled-${suffix}@outsider.test`],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          `INSERT INTO storage_migrations (tenant_id, destination_target_id, mode)
           VALUES ($1, $2, 'move')`,
          [outsider, contosoTarget],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("keeps the tenant customer number unique per installation, case-insensitively", async () => {
    try {
      await owner.query("UPDATE tenants SET customer_number = $1 WHERE id = $2", [
        "K-100",
        contoso,
      ]);
      await expect(
        owner.query("UPDATE tenants SET customer_number = $1 WHERE id = $2", ["k-100", fabrikam]),
      ).rejects.toThrow(/tenants_customer_number_uq/);
    } finally {
      // Leave the fixture tenant as the other tests found it.
      await owner.query("UPDATE tenants SET customer_number = NULL WHERE id = $1", [contoso]);
    }
    // With both tenants back to no customer number, any number of NULLs
    // coexist without tripping the partial unique index.
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*) AS n FROM tenants WHERE customer_number IS NULL",
    );
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it("keeps notification recipient emails unique per tenant, case-insensitively, but the same address is fine in another tenant", async () => {
    const email = `dupe-${suffix}@contoso.test`;
    // Give contoso the base row inside this test so the assertions below
    // never depend on insertion order with other tests.
    await inTransaction(app, contoso, (client) =>
      client.query(
        "INSERT INTO tenant_notification_recipients (tenant_id, email) VALUES ($1, $2)",
        [contoso, email],
      ),
    );
    // A different-case duplicate for the same tenant collides on the
    // case-insensitive unique index.
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          "INSERT INTO tenant_notification_recipients (tenant_id, email) VALUES ($1, $2)",
          [contoso, `Dupe-${suffix}@Contoso.test`],
        ),
      ),
    ).rejects.toThrow(/tenant_notification_recipients_tenant_email_uq/);
    // The exact same address is fine for a different tenant: uniqueness is per tenant.
    await expect(
      inTransaction(app, fabrikam, (client) =>
        client.query(
          "INSERT INTO tenant_notification_recipients (tenant_id, email) VALUES ($1, $2)",
          [fabrikam, email],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("gives one Entra identity at most one user", async () => {
    const tenantId = randomUUID();
    const objectId = randomUUID();
    const insertUser = (email: string, entra: [string, string] | null) =>
      app.query(
        `INSERT INTO "user" (id, name, email, entra_tenant_id, entra_object_id)
         VALUES ($1, $2, $2, $3, $4)`,
        [randomUUID(), email, entra?.[0] ?? null, entra?.[1] ?? null],
      );
    await insertUser(`adele-${suffix}@contoso.test`, [tenantId, objectId]);
    await expect(
      insertUser(`adele.vance-${suffix}@contoso.test`, [tenantId, objectId]),
    ).rejects.toThrow(/user_entra_identity_uidx/);
    // The same object id in another Entra tenant is another person.
    await insertUser(`adele-${suffix}@fabrikam.test`, [randomUUID(), objectId]);
    // Operators and IMAP users have no Entra identity; any number of them may exist.
    await insertUser(`operator-${suffix}@example.test`, null);
    await insertUser(`imap-${suffix}@example.test`, null);
  });

  it("hands the pg-boss schema to the installation role and lets the application enqueue", async () => {
    const { rows } = await owner.query<{ schema_owner: string; table_owner: string }>(
      `SELECT pg_get_userbyid(n.nspowner) AS schema_owner, pg_get_userbyid(c.relowner) AS table_owner
         FROM pg_namespace n JOIN pg_class c ON c.relnamespace = n.oid
        WHERE n.nspname = 'pgboss' AND c.relname = 'job'`,
    );
    expect(rows[0]).toEqual({
      schema_owner: installationLogin.name,
      table_owner: installationLogin.name,
    });
    await inTransaction(app, contoso, (client) =>
      client.query("INSERT INTO pgboss.job (id, name) VALUES ($1, 'backup')", [randomUUID()]),
    );
    // Tables pg-boss creates later (one per queue) are covered by the default privileges.
    await provider.query("CREATE TABLE pgboss.j_backup (id uuid PRIMARY KEY)");
    await inTransaction(app, contoso, (client) =>
      client.query("INSERT INTO pgboss.j_backup (id) VALUES ($1)", [randomUUID()]),
    );
  });
});
