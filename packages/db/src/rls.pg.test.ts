/**
 * Row Level Security as the application actually runs it: connected as the
 * provisioned application role, not as the owner.
 *
 * The migration step provisions three login roles next to the owner. This
 * suite migrates a scratch database with them, writes two tenants as the owner
 * and then proves, connected as each role, that
 *
 *   - the application role is neither superuser nor BYPASSRLS and owns nothing,
 *   - an unpinned transaction on it sees no tenant row at all,
 *   - a transaction pinned to tenant A sees A's rows and none of B's, and cannot
 *     write a row for B,
 *   - it cannot rewrite the audit log,
 *   - it cannot read or write the better-auth tables (sessions, password
 *     hashes, TOTP secrets, passkeys, verification tokens, memberships), only
 *     the name and address of a user, nor the installation tables (settings,
 *     license, providers, service heartbeats, the provider team): permission
 *     denied, whatever the query; and every table's grants match its
 *     classification in roles.ts `TABLE_ACCESS`,
 *   - the auth role (derived from the other two logins) is subject to Row
 *     Level Security as well, reaches the better-auth tables, reads a tenant
 *     and appends to its audit chain only when pinned to it, and touches no
 *     other tenant data,
 *   - the installation role keeps the service heartbeats (never with an IP
 *     address as host name) and the auth role the auth rate-limit counters,
 *   - a verification report and its snapshot link stay inside the tenant, and
 *     one Entra identity belongs to at most one user,
 *   - the installation role sees every tenant, which is what the lookups made
 *     before a tenant is known rely on,
 *   - a pg-boss schema created earlier by the owner is handed to the
 *     installation role, and the application role may enqueue into it and do
 *     nothing else there,
 *   - an installation provisioned by 0.3.4, whose application role had every
 *     table and the pg-boss schema, loses those grants on the next migration.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser
 * (roles are cluster-wide: the suite creates uniquely named ones and drops them
 * again). Without it the suite is skipped; docs/TESTING.md lists it under
 * integration.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { is, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "./index.js";
import {
  manifestEntries,
  objectsReferencingChunks,
  recordManifestVersions,
  releaseManifestSnapshot,
} from "./manifest-versions.js";
import { runMigrations } from "./migrate.js";
import {
  type RoleLogin,
  TABLE_ACCESS,
  TENANT_USER_COLUMNS,
  assertDatabaseRoles,
  deriveAuthLogin,
  grantQueueAccess,
  inspectCurrentRole,
  roleProblems,
} from "./roles.js";
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
const authLogin = deriveAuthLogin(tenantLogin, installationLogin);

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
  let authPool: pg.Pool;
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
    authPool = new pg.Pool({ connectionString: urlFor(base, DATABASE, authLogin) });
  });

  afterAll(async () => {
    await Promise.all([app?.end(), provider?.end(), authPool?.end(), owner?.end()]);
    if (!adminUrl) {
      return;
    }
    await dropTestDatabase(adminUrl, DATABASE);
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`DROP ROLE IF EXISTS ${tenantLogin.name}`);
      await admin.query(`DROP ROLE IF EXISTS ${installationLogin.name}`);
      await admin.query(`DROP ROLE IF EXISTS ${authLogin.name}`);
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

  it("provisions an auth role, derived from the other two logins, that Row Level Security binds", async () => {
    const roles = await assertDatabaseRoles({
      tenant: app,
      installation: provider,
      auth: authPool,
    });
    expect(roles.auth).toMatchObject({
      name: authLogin.name,
      superuser: false,
      bypassRls: false,
      ownsTables: false,
    });
    expect(authLogin.name).toBe(`${tenantLogin.name}_auth`);
    await expect(
      assertDatabaseRoles({ tenant: app, installation: provider, auth: provider }),
    ).rejects.toThrow(/DATABASE_AUTH_URL/);
    await expect(
      assertDatabaseRoles({ tenant: app, installation: provider, auth: app }),
    ).rejects.toThrow(/different roles/);
  });

  it("denies the application role every better-auth secret and every installation table", async () => {
    for (const table of [
      "session",
      "account",
      "two_factor",
      "passkey",
      "verification",
      "member",
      "organization",
      "invitation",
      "rate_limit",
      "settings",
      "license",
      "providers",
      "service_heartbeats",
      "provider_members",
      "provider_member_tenants",
    ]) {
      for (const tenantId of [null, contoso]) {
        await expect(
          inTransaction(app, tenantId, (client) => client.query(`SELECT 1 FROM ${table}`)),
          table,
        ).rejects.toThrow(/permission denied/);
      }
    }
    await expect(
      app.query(`UPDATE settings SET public_url = 'https://phish.example'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(`INSERT INTO license (edition, installation_id) VALUES ('service_provider', 'x')`),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets the application role read only a user's name and address", async () => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email, role) VALUES ($1, 'Megan', $2, 'admin')`,
      [id, `megan-${suffix}@contoso.test`],
    );
    const { rows } = await app.query(
      `SELECT ${TENANT_USER_COLUMNS.join(", ")} FROM "user" WHERE id = $1`,
      [id],
    );
    expect(rows).toEqual([{ id, name: "Megan", email: `megan-${suffix}@contoso.test` }]);
    for (const query of [
      `SELECT * FROM "user"`,
      `SELECT role FROM "user"`,
      `SELECT two_factor_enabled FROM "user"`,
    ]) {
      await expect(app.query(query), query).rejects.toThrow(/permission denied/);
    }
    // No write at all: a tenant-scoped flaw cannot make anyone a provider administrator.
    await expect(app.query(`UPDATE "user" SET name = 'x' WHERE id = $1`, [id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      app.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'x', $2)`, [
        randomUUID(),
        `x-${suffix}@contoso.test`,
      ]),
    ).rejects.toThrow(/permission denied/);
    await owner.query(`DELETE FROM "user" WHERE id = $1`, [id]);
  });

  it("gives the auth role the better-auth tables and, under Row Level Security, a tenant and its audit chain", async () => {
    const userId = randomUUID();
    await authPool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Lee', $2)`, [
      userId,
      `lee-${suffix}@contoso.test`,
    ]);
    await authPool.query(
      `INSERT INTO session (id, token, user_id, expires_at, updated_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now())`,
      [randomUUID(), `token-${suffix}`, userId],
    );
    await authPool.query(
      `INSERT INTO two_factor (id, secret, backup_codes, user_id) VALUES ($1, 'secret', '[]', $2)`,
      [randomUUID(), userId],
    );
    expect(
      (await authPool.query("SELECT 1 FROM session WHERE user_id = $1", [userId])).rowCount,
    ).toBe(1);

    // Tenants: only the pinned one, read-only.
    expect(
      (await inTransaction(authPool, null, (c) => c.query("SELECT id FROM tenants"))).rowCount,
    ).toBe(0);
    const seen = await inTransaction(authPool, contoso, (c) =>
      c.query<{ id: string }>("SELECT id FROM tenants"),
    );
    expect(seen.rows.map((row) => row.id)).toEqual([contoso]);
    await expect(
      inTransaction(authPool, contoso, (c) =>
        c.query("UPDATE tenants SET name = 'x' WHERE id = $1", [contoso]),
      ),
    ).rejects.toThrow(/permission denied/);
    // The audit chain: appended within the pinned tenant, never another one's.
    await inTransaction(authPool, contoso, (c) =>
      c.query(
        `INSERT INTO audit_log (tenant_id, actor, action, chain_hash) VALUES ($1, 'lee', 'account.password_set', $2)`,
        [contoso, `hash-${suffix}`],
      ),
    );
    await expect(
      inTransaction(authPool, contoso, (c) =>
        c.query(
          `INSERT INTO audit_log (tenant_id, actor, action, chain_hash) VALUES ($1, 'lee', 'x', 'y')`,
          [fabrikam],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Nothing else of a tenant, nor the installation's.
    for (const table of ["sources", "secrets", "tenant_keys", "settings", "license", "jobs"]) {
      await expect(
        inTransaction(authPool, contoso, (c) => c.query(`SELECT 1 FROM ${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
    await owner.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
  });

  it("grants every table exactly what roles.ts TABLE_ACCESS says", async () => {
    const tables = (Object.values(schema) as unknown[])
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => getTableConfig(table).name);
    expect(tables.length).toBeGreaterThan(50);
    const privileges = async (role: string, table: string) => {
      const { rows } = await owner.query<{ select: boolean; insert: boolean; any_column: boolean }>(
        `SELECT has_table_privilege($1, format('%I', $2::text), 'SELECT') AS select,
                has_table_privilege($1, format('%I', $2::text), 'INSERT') AS insert,
                has_any_column_privilege($1, format('%I', $2::text), 'SELECT') AS any_column`,
        [role, table],
      );
      return rows[0];
    };
    for (const table of tables) {
      const access = TABLE_ACCESS[table] ?? "tenant";
      const tenant = await privileges(tenantLogin.name, table);
      const auth = await privileges(authLogin.name, table);
      const installation = await privileges(installationLogin.name, table);
      expect(installation, `${table} installation`).toMatchObject({ select: true });
      if (access === "tenant") {
        expect(tenant, `${table} tenant`).toMatchObject({ select: true, insert: true });
      } else if (table === "user") {
        // Column grant only (TENANT_USER_COLUMNS).
        expect(tenant, `${table} tenant`).toEqual({
          select: false,
          insert: false,
          any_column: true,
        });
      } else {
        expect(tenant, `${table} tenant`).toEqual({
          select: false,
          insert: false,
          any_column: false,
        });
      }
      const authExpected = access === "auth" || table === "tenants" || table === "audit_log";
      expect(auth.any_column, `${table} auth`).toBe(authExpected);
    }
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

  it("keeps an archived mail's mailbox assignments inside the tenant and append-only", async () => {
    const { rows: objects } = await owner.query<{ id: string }>(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id)
         SELECT tenant_id, id, 'mailbox', 'journal-assign@contoso.example' FROM sources WHERE tenant_id = $1
       RETURNING id`,
      [contoso],
    );
    const { rows: items } = await owner.query<{ id: string }>(
      `INSERT INTO archive_items (tenant_id, message_id, item_hash, chain_hash, received_at, captured_via, storage_path)
         VALUES ($1, '<assign@contoso.example>', 'item', $2, now(), 'journal', 'archive/assign')
       RETURNING id`,
      [contoso, `chain-${randomUUID()}`],
    );
    const objectId = objects[0]?.id as string;
    const itemId = items[0]?.id as string;

    await inTransaction(app, contoso, (client) =>
      client.query(
        "INSERT INTO archive_item_mailboxes (tenant_id, archive_item_id, protected_object_id) VALUES ($1, $2, $3)",
        [contoso, itemId, objectId],
      ),
    );
    const seen = await inTransaction(app, fabrikam, (client) =>
      client.query("SELECT id FROM archive_item_mailboxes WHERE archive_item_id = $1", [itemId]),
    );
    expect(seen.rowCount).toBe(0);
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query("DELETE FROM archive_item_mailboxes WHERE archive_item_id = $1", [itemId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query(
          "UPDATE archive_item_mailboxes SET created_at = now() WHERE archive_item_id = $1",
          [itemId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      owner.query(
        "UPDATE archive_item_mailboxes SET created_at = now() WHERE archive_item_id = $1",
        [itemId],
      ),
    ).rejects.toThrow(/append-only/);

    // The retention run removes the item; its assignments go with it.
    await provider.query("DELETE FROM archive_items WHERE id = $1", [itemId]);
    const left = await owner.query(
      "SELECT id FROM archive_item_mailboxes WHERE archive_item_id = $1",
      [itemId],
    );
    expect(left.rowCount).toBe(0);
  });

  it("lets the installation role see every tenant", async () => {
    const { rows } = await provider.query<{ id: string }>("SELECT id FROM tenants ORDER BY slug");
    expect(rows.map((row) => row.id)).toEqual([contoso, fabrikam]);
    expect((await inspectCurrentRole(provider)).name).toBe(installationLogin.name);
  });

  it("lets the installation role keep the service heartbeats, outside any tenant", async () => {
    const instanceId = `worker-${suffix}`;
    const beat = (pool: pg.Pool, hostname: string | null) =>
      pool.query(
        `INSERT INTO service_heartbeats (role, instance_id, version, hostname, started_at)
         VALUES ('worker', $1, '0.301.0', $2, now())
         ON CONFLICT (instance_id) DO UPDATE SET beat_at = now(), hostname = EXCLUDED.hostname`,
        [instanceId, hostname],
      );
    // Installation-level: the application role is refused, pinned or not.
    await expect(beat(app, "restow-worker-1")).rejects.toThrow(/permission denied/);
    await beat(provider, "restow-worker-2");
    const seen = await provider.query<{ hostname: string }>(
      "SELECT hostname FROM service_heartbeats WHERE instance_id = $1",
      [instanceId],
    );
    expect(seen.rows).toEqual([{ hostname: "restow-worker-2" }]);
    // Container ids can be all digits; that is still a name.
    await beat(provider, "123456789012");
    await beat(provider, null);
    for (const address of ["10.0.0.7", "::1", "fe80::1%eth0", "::ffff:192.0.2.1"]) {
      await expect(beat(provider, address), address).rejects.toThrow(
        /service_heartbeats_hostname_not_ip/,
      );
    }
    expect(
      (await provider.query("DELETE FROM service_heartbeats WHERE instance_id = $1", [instanceId]))
        .rowCount,
    ).toBe(1);
  });

  it("lets the auth role keep the auth rate-limit counters", async () => {
    const key = `198.51.100.7|/sign-in/email|${suffix}`;
    await authPool.query(
      "INSERT INTO rate_limit (id, key, count, last_request) VALUES ($1, $2, 1, $3)",
      [randomUUID(), key, Date.now()],
    );
    await authPool.query("UPDATE rate_limit SET count = count + 1 WHERE key = $1", [key]);
    const { rows } = await authPool.query<{ count: number }>(
      "SELECT count FROM rate_limit WHERE key = $1",
      [key],
    );
    expect(rows).toEqual([{ count: 2 }]);
    await expect(
      authPool.query(
        "INSERT INTO rate_limit (id, key, count, last_request) VALUES ($1, $2, 1, 0)",
        [randomUUID(), key],
      ),
    ).rejects.toThrow(/rate_limit_key_unique/);
    expect((await authPool.query("DELETE FROM rate_limit WHERE key = $1", [key])).rowCount).toBe(1);
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

  it("keeps the manifest index (versions and the 0.3.4 rows) inside the tenant", async () => {
    const [object] = (
      await owner.query<{ id: string }>(
        `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id)
         SELECT tenant_id, id, 'mailbox', 'index@contoso.test' FROM sources WHERE tenant_id = $1
         RETURNING id`,
        [contoso],
      )
    ).rows;
    const objectId = object?.id as string;
    const [snapshot] = (
      await owner.query<{ id: string }>(
        `INSERT INTO snapshots (tenant_id, protected_object_id, sequence, manifest_path)
         VALUES ($1, $2, 1, 'm') RETURNING id`,
        [contoso, objectId],
      )
    ).rows;
    const snapshotId = snapshot?.id as string;
    const scope = { tenantId: contoso, protectedObjectId: objectId, snapshotId, sequence: 1 };
    const pinned = async <T>(
      tenantId: string,
      fn: (db: ReturnType<typeof drizzle>) => Promise<T>,
    ) =>
      drizzle(app).transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
        return fn(tx as unknown as ReturnType<typeof drizzle>);
      });
    // The application role mirrors a snapshot of its own tenant...
    await pinned(contoso, (tx) =>
      recordManifestVersions(tx, scope, [
        {
          kind: "mail",
          path: "mail/Inbox/a.eml",
          name: "a.eml",
          parentPath: "mail/Inbox",
          size: 1,
          mtime: null,
          itemId: "a",
          messageId: null,
          chunkRefs: ["ab".repeat(32)],
          metadata: { subject: "Secret" },
        },
      ]),
    );
    const entries = (tenantId: string) =>
      pinned(tenantId, async (tx) => ({
        versions: (await tx.execute(sql`SELECT id FROM manifest_versions`)).rows.length,
        entries: (
          await tx.execute(
            sql`SELECT * FROM ${manifestEntries({ tenantId: contoso, snapshots: sql`s.id = ${snapshotId}::uuid` })} AS m`,
          )
        ).rows.length,
        chunks: await objectsReferencingChunks(tx, contoso, ["ab".repeat(32)]),
      }));
    expect(await entries(contoso)).toEqual({ versions: 1, entries: 1, chunks: [objectId] });
    // ...which another tenant neither sees, nor can release, nor write into.
    expect(await entries(fabrikam)).toEqual({ versions: 0, entries: 0, chunks: [] });
    expect(await pinned(fabrikam, (tx) => releaseManifestSnapshot(tx, scope))).toBe(0);
    await expect(
      pinned(fabrikam, (tx) => recordManifestVersions(tx, { ...scope, sequence: 2 }, [])),
    ).resolves.toMatchObject({ inserted: 0 });
    await expect(
      inTransaction(app, fabrikam, (client) =>
        client.query(
          `INSERT INTO manifest_versions (tenant_id, protected_object_id, first_sequence,
             last_sequence, content_hash, kind, path, name)
           VALUES ($1, $2, 1, 1, '\\x00', 'mail', 'smuggled', 'smuggled')`,
          [contoso, objectId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inTransaction(app, fabrikam, (client) =>
        client.query(
          `INSERT INTO manifest_objects (tenant_id, snapshot_id, protected_object_id, kind, path, name)
           VALUES ($1, $2, $3, 'mail', 'smuggled', 'smuggled')`,
          [contoso, snapshotId, objectId],
        ),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
    expect(await entries(contoso)).toEqual({ versions: 1, entries: 1, chunks: [objectId] });
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
      authPool.query(
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

  it("hands the pg-boss schema to the installation role and lets the application only enqueue", async () => {
    const { rows } = await owner.query<{ schema_owner: string; table_owner: string }>(
      `SELECT pg_get_userbyid(n.nspowner) AS schema_owner, pg_get_userbyid(c.relowner) AS table_owner
         FROM pg_namespace n JOIN pg_class c ON c.relnamespace = n.oid
        WHERE n.nspname = 'pgboss' AND c.relname = 'job'`,
    );
    expect(rows[0]).toEqual({
      schema_owner: installationLogin.name,
      table_owner: installationLogin.name,
    });
    const id = randomUUID();
    const inserted = await inTransaction(app, contoso, (client) =>
      client.query<{ id: string }>(
        "INSERT INTO pgboss.job (id, name) VALUES ($1, 'backup') RETURNING id",
        [id],
      ),
    );
    expect(inserted.rows).toEqual([{ id }]);
    // Nothing else: no payload, no change, no cancel, no delete.
    for (const query of [
      "SELECT * FROM pgboss.job",
      "SELECT name FROM pgboss.job",
      "UPDATE pgboss.job SET name = 'x'",
      "DELETE FROM pgboss.job",
    ]) {
      await expect(app.query(query), query).rejects.toThrow(/permission denied/);
    }
    // Tables pg-boss creates later (one per queue) are not the application role's:
    // jobs reach them through pgboss.job.
    await provider.query("CREATE TABLE pgboss.j_backup (id uuid PRIMARY KEY)");
    await expect(
      inTransaction(app, contoso, (client) =>
        client.query("INSERT INTO pgboss.j_backup (id) VALUES ($1)", [randomUUID()]),
      ),
    ).rejects.toThrow(/permission denied/);
    await provider.query("DROP TABLE pgboss.j_backup");
  });

  it("takes the 0.3.4 grants away from the application role on the next migration", async () => {
    // What provisioning granted until 0.3.4: every table, and whatever the
    // installation role created in the pg-boss schema.
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${tenantLogin.name}`,
    );
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${tenantLogin.name}`,
    );
    await owner.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${installationLogin.name} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${tenantLogin.name}`,
    );
    expect((await app.query("SELECT 1 FROM session")).rowCount).toBe(0);

    await runMigrations(urlFor(adminUrl as string, DATABASE), {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });

    for (const query of [
      "SELECT 1 FROM session",
      "SELECT 1 FROM settings",
      "SELECT * FROM pgboss.job",
      `SELECT role FROM "user"`,
    ]) {
      await expect(app.query(query), query).rejects.toThrow(/permission denied/);
    }
    const { rows } = await owner.query<{ granted: number }>(
      `SELECT count(*)::int AS granted FROM pg_default_acl d
        WHERE d.defaclrole = $1::regrole
          AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = $2::regrole)`,
      [installationLogin.name, tenantLogin.name],
    );
    expect(rows[0]?.granted).toBe(0);
  });

  it("lets the worker and the scheduler give the queue grants again after pg-boss rebuilt its schema", async () => {
    await provider.query("DROP TABLE pgboss.job");
    await provider.query("CREATE TABLE pgboss.job (id uuid PRIMARY KEY, name text NOT NULL)");
    await expect(
      app.query("INSERT INTO pgboss.job (id, name) VALUES ($1, 'backup')", [randomUUID()]),
    ).rejects.toThrow(/permission denied/);
    // Concurrently, as both processes start at the same time.
    await Promise.all([
      grantQueueAccess(provider, tenantLogin.name),
      grantQueueAccess(provider, tenantLogin.name),
    ]);
    await app.query("INSERT INTO pgboss.job (id, name) VALUES ($1, 'backup')", [randomUUID()]);
    await expect(app.query("SELECT name FROM pgboss.job")).rejects.toThrow(/permission denied/);
  });
});
