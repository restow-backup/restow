/**
 * A scratch installation for the Postgres-backed tests of endpoint backup:
 * a migrated database with the provisioned application and installation roles
 * (as in production), two tenants with keys, an admin, and a local storage
 * directory as the installation-default storage target.
 *
 * The API's shared database handles read the environment when they are first
 * imported, so everything that touches them is imported after `startFixture`
 * has set it.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resticBinary } from "@restow/core";
import { type Database, createDb, providers, tenants, user } from "@restow/db";
import { type TestDatabaseRoles, provisionTestRoles } from "../../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../snapshots/testing/explorer-fixture.js";

export { testDatabaseAdminUrl };

/** Whether a restic binary can be started (RESTIC_BINARY, else the PATH). */
export function resticAvailable(): boolean {
  const result = spawnSync(resticBinary(), ["version"], { encoding: "utf8" });
  return result.status === 0 && /^restic 0\.\d+/.test(result.stdout);
}

export interface EndpointFixture {
  /** The owner: fixtures and assertions, RLS does not bind it. */
  db: Database;
  storageDir: string;
  cacheDir: string;
  tenantId: string;
  otherTenantId: string;
  adminId: string;
  roles: TestDatabaseRoles;
  cleanup(): Promise<void>;
}

export async function startFixture(databaseName: string): Promise<EndpointFixture> {
  const url = await recreateDatabase(testDatabaseAdminUrl as string, databaseName);
  const roles = await provisionTestRoles(url);
  const storageDir = await mkdtemp(join(tmpdir(), "restow-endpoints-storage-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "restow-endpoints-cache-"));
  process.env.DATABASE_URL = roles.appUrl;
  process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
  process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
  process.env.BETTER_AUTH_SECRET = randomBytes(24).toString("base64");
  process.env.RESTOW_PUBLIC_URL = "https://restow.test.example";
  process.env.STORAGE_TARGET = "local";
  process.env.STORAGE_LOCAL_PATH = storageDir;
  process.env.RESTOW_RESTIC_CACHE_DIR = cacheDir;

  const db = createDb(url);
  const secretStore = await import("../../../lib/secrets.js");
  const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
  const [tenant, other] = await db
    .insert(tenants)
    .values([
      { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso-gmbh" },
      { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
    ])
    .returning();
  const tenantId = tenant?.id ?? "";
  const otherTenantId = other?.id ?? "";
  for (const id of [tenantId, otherTenantId]) {
    await db.transaction((tx) => secretStore.createTenantKey(tx, id));
  }
  const adminId = randomUUID();
  await db.insert(user).values({
    id: adminId,
    name: "Admin",
    email: "admin@contoso.example",
    emailVerified: true,
  });
  return {
    db,
    storageDir,
    cacheDir,
    tenantId,
    otherTenantId,
    adminId,
    roles,
    async cleanup() {
      const shared = await import("../../../db.js");
      await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
      await db.$client.end();
      await dropDatabase(testDatabaseAdminUrl as string, databaseName);
      await roles.drop(testDatabaseAdminUrl as string);
      await rm(storageDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

/** The Basic credentials an agent presents. */
export function basic(endpointId: string, secret: string): { authorization: string } {
  return {
    authorization: `Basic ${Buffer.from(`${endpointId}:${secret}`).toString("base64")}`,
  };
}
