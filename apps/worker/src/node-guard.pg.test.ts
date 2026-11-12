/**
 * A worker node's database access against Postgres (node-guard.ts, packages/db node-roles.ts):
 * with the logins a join creates, the schema check reads the migration journal (it must, or the
 * node would never start), and the job queue works on the node role (start, enqueue, fetch,
 * complete) although that role owns nothing of the pg-boss schema; the queue grants are left to
 * the main host (`grantQueueAccess` does nothing on a node).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { randomBytes } from "node:crypto";
import {
  createDb,
  createNodeLogins,
  dropNodeLogins,
  grantQueueAccess,
  type NodeLogins,
  nodeInstallationRoleName,
  type RoleLogin,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schemaVersion } from "./node-guard.js";
import { dropTestDatabase, ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const TEST_DB = `restow_worker_node_${suffix}`;

function urlFor(login?: RoleLogin): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${TEST_DB}`;
  if (login) {
    url.username = login.name;
    url.password = login.password;
  }
  return url.toString();
}

describe.skipIf(!adminUrl)("a worker node against Postgres", () => {
  const tenant: RoleLogin = {
    name: `restow_test_app_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  };
  const installation: RoleLogin = {
    name: `restow_test_provider_${suffix}`,
    password: randomBytes(18).toString("base64url"),
  };
  let owner: ReturnType<typeof createDb>;
  let logins: NodeLogins;

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    await runMigrations(urlFor(), { roles: { tenant, installation } });
    // The main host's worker sets up pg-boss as the installation role and grants the queues.
    const main = new PgBoss({ connectionString: urlFor(installation), supervise: false });
    main.on("error", ignoreTerminatedConnection);
    await main.start();
    await main.createQueue("node-test");
    const mainDb = createDb(urlFor(installation), { max: 1 });
    await grantQueueAccess(mainDb.$client, tenant.name);
    await mainDb.$client.end();
    await main.stop({ graceful: false, wait: true });
    owner = createDb(urlFor(), { max: 1 });
    owner.$client.on("error", ignoreTerminatedConnection);
    const client = await owner.$client.connect();
    try {
      logins = await createNodeLogins(client, {
        nodeKey: randomBytes(6).toString("hex"),
        tenantRole: tenant.name,
        installationRole: installation.name,
      });
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (!adminUrl) {
      return;
    }
    if (logins) {
      await dropNodeLogins(owner.$client, [logins.app.name, logins.installation.name]).catch(
        () => undefined,
      );
    }
    await owner?.$client.end();
    await dropTestDatabase(adminUrl, TEST_DB);
    const admin = createDb(adminUrl);
    for (const name of [
      tenant.name,
      installation.name,
      `${tenant.name}_auth`,
      nodeInstallationRoleName(installation.name),
    ]) {
      await admin.$client.query(`DROP ROLE IF EXISTS ${name}`).catch(() => undefined);
    }
    await admin.$client.end();
  });

  it("reads the schema version with the node's installation login", async () => {
    const node = createDb(urlFor(logins.installation), { max: 1 });
    try {
      const version = await schemaVersion(node.$client);
      expect(version.applied).toBe(version.shipped);
      expect(version.newer).toBe(false);
    } finally {
      await node.$client.end();
    }
  });

  it("works the job queue on the node role, leaving the grants to the main host", async () => {
    const node = createDb(urlFor(logins.installation), { max: 1 });
    const boss = new PgBoss({ connectionString: urlFor(logins.installation) });
    boss.on("error", ignoreTerminatedConnection);
    try {
      await boss.start();
      await grantQueueAccess(node.$client, tenant.name);
      await boss.createQueue("node-test");
      await boss.updateQueue("node-test", { name: "node-test", retryLimit: 1 });
      const id = await boss.send("node-test", { hello: "node" });
      expect(id).toBeTruthy();
      const [job] = await boss.fetch("node-test");
      expect(job?.id).toBe(id);
      await boss.complete("node-test", job?.id as string);
      // A queue the main host has not created yet would need a table: the node cannot make one.
      await expect(boss.createQueue("node-only")).rejects.toThrow(/permission denied/);
    } finally {
      await boss.stop({ graceful: false, wait: true });
      await node.$client.end();
    }
  });
});
