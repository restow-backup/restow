/**
 * Installation > Cluster (service.ts) against Postgres: join tokens are refused while the database
 * is not reachable from the network and while a target lives in a Docker volume; a token is shown
 * once and stored as its hash; a node of another release is refused without using the token up, a
 * token bound to an address only works from there; a redeemed token gives the node its own logins
 * (which switch to the tenant and installation roles and pass the startup check), the master key
 * and the storage settings, never the owner's connection or the auth secret; it cannot be used
 * twice; a revoked token is refused; removing the node revokes its logins; everything is audited.
 * The node's installation login passes `restow node check` (roles, schema, node) but cannot plant
 * a join token or change a password hash, and a row planted with a plain hash cannot be redeemed.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDatabaseRoles, createDb, type Database } from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_cluster_test";
const ACTOR = { userId: "u-owner", email: "owner@example.com", ip: "203.0.113.5" };

describe.skipIf(!testDatabaseAdminUrl)("worker nodes against Postgres", () => {
  let ownerUrl: string;
  let owner: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let root: string;
  let env: Record<string, string>;
  let service: typeof import("./service.js");
  const dbAddress = new URL(testDatabaseAdminUrl ?? "postgres://localhost:5432").host;

  beforeAll(async () => {
    ownerUrl = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(ownerUrl);
    root = await mkdtemp(join(tmpdir(), "restow-cluster-"));
    await writeFile(
      join(root, "ca.crt"),
      "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
    );
    env = {
      DATABASE_MIGRATION_URL: ownerUrl,
      DATABASE_URL: roles.appUrl,
      DATABASE_PROVIDER_URL: roles.providerUrl,
      RESTOW_MASTER_KEY: randomBytes(32).toString("base64"),
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
      RESTOW_VERSION: "0.5.0",
      RESTOW_IMAGE: "ghcr.io/restow-backup/restow:0.5.0",
      RESTOW_PUBLIC_URL: "https://backup.example.com",
      RESTOW_CLUSTER_DB_ADDRESS: dbAddress,
      RESTOW_CLUSTER_DB_CA_FILE: join(root, "ca.crt"),
      STORAGE_TARGET: "local",
      STORAGE_LOCAL_PATH: "/srv/restow-backups",
      S3_REGION: "eu-central-1",
    };
    Object.assign(process.env, env);
    owner = createDb(ownerUrl);
    providerDb = createDb(roles.providerUrl);
    service = await import("./service.js");
  }, 120_000);

  afterAll(async () => {
    const shared = await import("../../db.js").catch(() => null);
    await Promise.allSettled([
      owner?.$client.end(),
      providerDb?.$client.end(),
      shared?.db.$client.end(),
      shared?.providerDb.$client.end(),
      shared?.authDb.$client.end(),
    ]);
    const admin = createDb(testDatabaseAdminUrl as string, { max: 1 });
    const { rows } = await admin.$client.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'restow_node_%'",
    );
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    for (const { rolname } of rows) {
      await admin.$client.query(`DROP ROLE IF EXISTS "${rolname}"`).catch(() => undefined);
    }
    await admin.$client.end();
    await roles?.drop(testDatabaseAdminUrl as string);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const auditCount = async (action: string) =>
    Number(
      (
        await owner.$client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM audit_log WHERE action = $1",
          [action],
        )
      ).rows[0]?.count ?? 0,
    );

  it("refuses a token while the database is not exposed or a target is in a Docker volume", async () => {
    const { RESTOW_CLUSTER_DB_ADDRESS: _address, ...notExposed } = env;
    await expect(
      service.createJoinToken(
        providerDb,
        { nodeName: "worker-1", ttlMinutes: 60, standbyScheduler: false, actor: ACTOR },
        notExposed,
      ),
    ).rejects.toMatchObject({ status: 409, extensions: { code: "database_not_exposed" } });

    const provider = await owner.$client.query<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('Provider') RETURNING id::text AS id",
    );
    const tenant = await owner.$client.query<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso') RETURNING id::text AS id",
      [provider.rows[0]?.id],
    );
    const target = await owner.$client.query<{ id: string }>(
      `INSERT INTO storage_targets (tenant_id, name, kind, role, config)
       VALUES ($1, 'In the volume', 'local', 'copy', '{"basePath":"/data/contoso"}') RETURNING id::text AS id`,
      [tenant.rows[0]?.id],
    );
    const view = await service.clusterView(providerDb, env);
    expect(view.joinBlocked).toBe(true);
    expect(view.targets.find((entry) => entry.path === "/data/contoso")?.kind).toBe("volume");
    expect(view.targets.find((entry) => entry.targetId === "default")?.kind).toBe("directory");
    await expect(
      service.createJoinToken(
        providerDb,
        { nodeName: "worker-1", ttlMinutes: 60, standbyScheduler: false, actor: ACTOR },
        env,
      ),
    ).rejects.toMatchObject({ extensions: { code: "volume_targets" } });
    await owner.$client.query(
      `UPDATE storage_targets SET config = '{"basePath":"/mnt/restow/share"}' WHERE id = $1`,
      [target.rows[0]?.id],
    );
  });

  it("joins a node once, with its own logins and only what a worker needs", async () => {
    const created = await service.createJoinToken(
      providerDb,
      {
        nodeName: "worker-1",
        expectedAddress: "198.51.100.20",
        ttlMinutes: 60,
        standbyScheduler: true,
        actor: ACTOR,
      },
      env,
    );
    expect(created.token).toMatch(/^rsj_[0-9A-Za-z]{40}$/);
    const stored = await owner.$client.query<{ token_hash: string }>(
      "SELECT token_hash FROM cluster_join_tokens WHERE id = $1",
      [created.id],
    );
    expect(stored.rows[0]?.token_hash).not.toContain(created.token);
    const listed = await service.clusterView(providerDb, env);
    expect(listed.tokens.map((token) => token.prefix)).toEqual([created.prefix]);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const request = {
      token: created.token,
      nodeName: "worker-1",
      hostname: "worker-1.example.com",
      version: "0.5.0",
      ip: "198.51.100.20",
    };
    await expect(
      service.redeemJoinToken(providerDb, { ...request, version: "0.4.12" }, env),
    ).rejects.toMatchObject({ status: 409, extensions: { code: "version_mismatch" } });
    await expect(
      service.redeemJoinToken(providerDb, { ...request, ip: "198.51.100.99" }, env),
    ).rejects.toMatchObject({ status: 403 });

    const joined = await service.redeemJoinToken(providerDb, request, env);
    expect(joined.node.name).toBe("worker-1");
    expect(joined.standbyScheduler).toBe(true);
    expect(joined.caCertificate).toContain("BEGIN CERTIFICATE");
    expect(joined.directories).toEqual(["/mnt/restow/share", "/srv/restow-backups"]);
    expect(joined.env.RESTOW_MASTER_KEY).toBe(env.RESTOW_MASTER_KEY);
    expect(joined.env.RESTOW_NODE_ID).toBe(joined.node.id);
    expect(joined.env.RESTOW_WORKER_EXCLUDE_QUEUES).toBe("import");
    expect(joined.env.STORAGE_LOCAL_PATH).toBe("/srv/restow-backups");
    expect(joined.env.S3_REGION).toBe("eu-central-1");
    for (const forbidden of ["BETTER_AUTH_SECRET", "DATABASE_MIGRATION_URL", "POSTGRES_PASSWORD"]) {
      expect(joined.env).not.toHaveProperty(forbidden);
    }
    const text = JSON.stringify(joined);
    for (const secret of [env.BETTER_AUTH_SECRET, roles?.appUrl, roles?.providerUrl, ownerUrl]) {
      expect(text).not.toContain(secret);
    }
    const app = new URL(joined.env.DATABASE_URL ?? "");
    expect(app.username).toMatch(/^restow_node_[0-9a-f]{12}_app$/);
    expect(app.searchParams.get("sslmode")).toBe("verify-full");
    expect(app.host).toBe(dbAddress);

    // The node's logins, without TLS here (the test server has none).
    const plain = (raw: string) => {
      const url = new URL(raw);
      url.search = "";
      return url.toString();
    };
    const nodeApp = createDb(plain(joined.env.DATABASE_URL ?? ""), { max: 1 });
    const nodeInst = createDb(plain(joined.env.DATABASE_PROVIDER_URL ?? ""), { max: 1 });
    try {
      const checked = await assertDatabaseRoles({
        tenant: nodeApp.$client,
        installation: nodeInst.$client,
      });
      expect(checked.tenant.name).toBe(new URL(roles?.appUrl ?? "").username);
      expect(checked.installation.bypassRls).toBe(true);
      // Not the api's installation role: the node role of that installation.
      expect(checked.installation.name).toBe(`${new URL(roles?.providerUrl ?? "").username}_node`);
      // `restow node check` as the node: roles, schema version and node pass (TLS cannot here).
      const { nodeChecks } = await import("../../cli/restore.js");
      process.env.RESTOW_NODE_ID = joined.node.id;
      process.env.RESTOW_NODE_NAME = joined.node.name;
      try {
        const checks = await nodeChecks(nodeApp, nodeInst);
        const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
        expect(byName.roles?.ok, byName.roles?.detail).toBe(true);
        expect(byName.schema?.ok, byName.schema?.detail).toBe(true);
        expect(byName.node?.ok, byName.node?.detail).toBe(true);
      } finally {
        delete process.env.RESTOW_NODE_ID;
        delete process.env.RESTOW_NODE_NAME;
      }
      // A worker host taken over cannot plant a join token nor take over an account.
      const planted = `rsj_${"A".repeat(40)}`;
      await expect(
        nodeInst.$client.query(
          `INSERT INTO cluster_join_tokens (token_hash, prefix, node_name, db_address, created_by, expires_at)
           VALUES ($1, 'rsj_AAAA', 'worker-1', $2, '{}'::jsonb, now() + interval '10 years')`,
          [createHash("sha256").update(planted).digest("hex"), dbAddress],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        nodeInst.$client.query("UPDATE account SET password = 'x' WHERE false"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await Promise.all([nodeApp.$client.end(), nodeInst.$client.end()]);
    }

    await expect(service.redeemJoinToken(providerDb, request, env)).rejects.toMatchObject({
      status: 401,
    });
    const view = await service.clusterView(providerDb, env);
    expect(view.tokens).toEqual([]);
    expect(view.nodes.map((node) => [node.name, node.status])).toEqual([
      ["main", "main"],
      ["worker-1", "active"],
    ]);
    expect(await auditCount("cluster.join_token.created")).toBe(1);
    expect(await auditCount("cluster.node.joined")).toBe(1);
    expect(await auditCount("cluster.node.join_refused")).toBe(3);

    await service.removeNode(providerDb, joined.node.id, ACTOR, env);
    const removed = createDb(plain(joined.env.DATABASE_URL ?? ""), { max: 1 });
    try {
      await expect(removed.$client.query("SELECT 1")).rejects.toThrow();
    } finally {
      await removed.$client.end().catch(() => undefined);
    }
    expect(await auditCount("cluster.node.removed")).toBe(1);
    expect((await service.clusterView(providerDb, env)).nodes).toHaveLength(1);
  });

  it("refuses a token row the api did not write", async () => {
    // Planted by someone who could write the table, with the plain SHA-256 of a chosen token.
    const planted = `rsj_${"B".repeat(40)}`;
    await owner.$client.query(
      `INSERT INTO cluster_join_tokens (token_hash, prefix, node_name, db_address, created_by, expires_at)
       VALUES ($1, 'rsj_BBBB', 'worker-9', $2, '{}'::jsonb, now() + interval '1 hour')`,
      [createHash("sha256").update(planted).digest("hex"), dbAddress],
    );
    await expect(
      service.redeemJoinToken(
        providerDb,
        { token: planted, nodeName: "worker-9", version: "0.5.0", ip: "198.51.100.30" },
        env,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await owner.$client.query("DELETE FROM cluster_join_tokens WHERE prefix = 'rsj_BBBB'");
  });

  it("refuses a revoked token", async () => {
    const created = await service.createJoinToken(
      providerDb,
      { nodeName: "worker-2", ttlMinutes: 15, standbyScheduler: false, actor: ACTOR },
      env,
    );
    await service.revokeJoinToken(providerDb, created.id, ACTOR);
    await expect(
      service.redeemJoinToken(
        providerDb,
        { token: created.token, nodeName: "worker-2", version: "0.5.0", ip: "198.51.100.21" },
        env,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(service.revokeJoinToken(providerDb, created.id, ACTOR)).rejects.toMatchObject({
      status: 404,
    });
    expect(await auditCount("cluster.join_token.revoked")).toBe(1);
  });
});
