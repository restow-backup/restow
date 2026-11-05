/**
 * The database logins of a worker node (node-roles.ts) against Postgres: each login switches to
 * the role it stands for at login, so the node's pools pass the same startup check as the main
 * host's (`assertDatabaseRoles`); the installation login bypasses Row Level Security through the
 * node role it switched to, the application login does not; both are members of `restow_nodes`;
 * the session still names the node; the node role reads the migration journal but cannot plant a
 * join token, touch the sign-in tables or the provider team, or create a schema; the migration
 * step renews its grants; and after the removal neither login can sign in any more.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appliedMigrationCount, runMigrations, shippedMigrationCount } from "./migrate.js";
import {
  createNodeLogins,
  dropNodeLogins,
  NODE_GROUP_ROLE,
  type NodeLogins,
} from "./node-roles.js";
import { assertDatabaseRoles, nodeInstallationRoleName, type RoleLogin } from "./roles.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const DATABASE = `restow_db_node_roles_${suffix}`;

function urlFor(base: string, database: string, login?: RoleLogin): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (login) {
    url.username = login.name;
    url.password = login.password;
  }
  return url.toString();
}

describe.skipIf(!adminUrl)("worker node logins against Postgres", () => {
  const tenant: RoleLogin = {
    name: `restow_test_app_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  };
  const installation: RoleLogin = {
    name: `restow_test_provider_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  };
  let ownerUrl: string;
  let owner: pg.Client;
  let logins: NodeLogins;
  const nodeKey = randomBytes(6).toString("hex");

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    await admin.end();
    ownerUrl = urlFor(adminUrl as string, DATABASE);
    await runMigrations(ownerUrl, { roles: { tenant, installation } });
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const provider = await owner.query<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('Provider') RETURNING id::text AS id",
    );
    for (const slug of ["contoso", "fabrikam"]) {
      await owner.query("INSERT INTO tenants (provider_id, name, slug) VALUES ($1, $2, $2)", [
        provider.rows[0]?.id,
        slug,
      ]);
    }
    logins = await createNodeLogins(owner, {
      nodeKey,
      tenantRole: tenant.name,
      installationRole: installation.name,
    });
  });

  afterAll(async () => {
    if (!adminUrl) {
      return;
    }
    await dropNodeLogins(owner, [logins.app.name, logins.installation.name]).catch(() => undefined);
    await owner.end();
    await dropTestDatabase(adminUrl, DATABASE);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    for (const name of [
      tenant.name,
      installation.name,
      `${tenant.name}_auth`,
      nodeInstallationRoleName(installation.name),
    ]) {
      await admin.query(`DROP ROLE IF EXISTS ${name}`).catch(() => undefined);
    }
    await admin.end();
  });

  it("switches to the tenant and installation roles at login and passes the startup check", async () => {
    const app = new pg.Pool({ connectionString: urlFor(adminUrl as string, DATABASE, logins.app) });
    const inst = new pg.Pool({
      connectionString: urlFor(adminUrl as string, DATABASE, logins.installation),
    });
    try {
      const roles = await assertDatabaseRoles({ tenant: app, installation: inst });
      expect(roles.tenant.name).toBe(tenant.name);
      expect(roles.installation.name).toBe(nodeInstallationRoleName(installation.name));
      expect(roles.installation.bypassRls).toBe(true);
      const session = await inst.query<{ session_user: string }>("SELECT session_user");
      expect(session.rows[0]?.session_user).toBe(logins.installation.name);
      // The installation role sees every tenant, the application role none without a pinned tenant.
      const all = await inst.query<{ count: number }>("SELECT count(*)::int AS count FROM tenants");
      expect(all.rows[0]?.count).toBe(2);
      const none = await app.query<{ count: number }>("SELECT count(*)::int AS count FROM tenants");
      expect(none.rows[0]?.count).toBe(0);
      // Installation tables stay the installation role's alone.
      await expect(app.query("SELECT 1 FROM settings")).rejects.toThrow(/permission denied/);
      const member = await owner.query<{ member: boolean }>(
        "SELECT pg_has_role($1, $2, 'MEMBER') AS member",
        [logins.app.name, NODE_GROUP_ROLE],
      );
      expect(member.rows[0]?.member).toBe(true);
    } finally {
      await Promise.all([app.end(), inst.end()]);
    }
  });

  it("gives the node role what a worker needs and nothing of the api's", async () => {
    const inst = new pg.Pool({
      connectionString: urlFor(adminUrl as string, DATABASE, logins.installation),
    });
    try {
      // The schema check of a node (node-guard.ts) reads the migration journal, as does the
      // installation role itself.
      expect(await appliedMigrationCount(inst)).toBe(shippedMigrationCount());
      const main = new pg.Client({
        connectionString: urlFor(adminUrl as string, DATABASE, installation),
      });
      await main.connect();
      try {
        expect(await appliedMigrationCount(main)).toBe(shippedMigrationCount());
      } finally {
        await main.end();
      }
      // Installation-level rows a worker writes (heartbeats, settings) stay writable.
      await inst.query("UPDATE settings SET public_url = public_url WHERE false");
      await inst.query("DELETE FROM service_heartbeats WHERE false");
      const nodes = await inst.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM cluster_nodes",
      );
      expect(nodes.rows[0]?.count).toBe(0);
      for (const statement of [
        `INSERT INTO cluster_join_tokens (token_hash, prefix, node_name, db_address, created_by, expires_at)
         VALUES ('planted', 'rsj_x', 'evil', 'db:5432', '{}'::jsonb, now() + interval '10 years')`,
        "UPDATE cluster_nodes SET status = 'active'",
        "SELECT 1 FROM cluster_join_tokens",
        `UPDATE account SET password = 'planted'`,
        "SELECT password FROM account",
        "DELETE FROM two_factor",
        "DELETE FROM passkey",
        "SELECT 1 FROM session",
        `UPDATE "user" SET role = 'admin'`,
        "INSERT INTO provider_members (user_id, role) VALUES ('x', 'owner')",
        "CREATE SCHEMA planted",
      ]) {
        await expect(inst.query(statement), statement).rejects.toThrow(/permission denied/);
      }
    } finally {
      await inst.end();
    }
    // A migration after the join renews the node role's grants and keeps the limits.
    await runMigrations(ownerUrl, { roles: { tenant, installation } });
    const again = new pg.Pool({
      connectionString: urlFor(adminUrl as string, DATABASE, logins.installation),
    });
    try {
      expect(await appliedMigrationCount(again)).toBe(shippedMigrationCount());
      await expect(again.query("SELECT 1 FROM cluster_join_tokens")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await again.end();
    }
  });

  it("revokes the logins on removal, also twice", async () => {
    await dropNodeLogins(owner, [logins.app.name, logins.installation.name]);
    await dropNodeLogins(owner, [logins.app.name, logins.installation.name]);
    const client = new pg.Client({
      connectionString: urlFor(adminUrl as string, DATABASE, logins.app),
    });
    await expect(client.connect()).rejects.toThrow();
    await client.end().catch(() => undefined);
    await expect(dropNodeLogins(owner, ["restow_app"])).rejects.toThrow(/not the login/);
  });
});
