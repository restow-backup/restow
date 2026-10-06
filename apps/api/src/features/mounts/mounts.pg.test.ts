/**
 * Postgres-backed test of what the api checks before it asks the mounter: the jobs
 * that run (across every tenant, on the installation pool) and the storage locations
 * that lie on a share (targets of any tenant and role, and the installation default
 * from the environment).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the
 * database `restow_api_mounts_test` is recreated there and dropped after, the roles
 * with it). Without it the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import { type Database, createDb, jobs, providers, storageTargets, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_mounts_test";

describe.skipIf(!testDatabaseAdminUrl)("mount checks against Postgres", () => {
  let db: Database;
  let roles: TestDatabaseRoles | undefined;
  let instance: typeof import("./instance.js");
  let contoso: string;
  let fabrikam: string;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.STORAGE_TARGET = "local";
    process.env.STORAGE_LOCAL_PATH = "/mnt/restow/main/chunks";
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const created = await db
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";
    await db.insert(storageTargets).values([
      {
        tenantId: contoso,
        kind: "local",
        role: "primary",
        name: "NAS",
        config: { basePath: "/mnt/restow/nas/contoso" },
      },
      {
        tenantId: fabrikam,
        kind: "local",
        role: "previous",
        name: "Old",
        config: { basePath: "/mnt/restow/nas" },
      },
      {
        tenantId: fabrikam,
        kind: "local",
        role: "copy",
        name: "Other",
        config: { basePath: "/mnt/restow/nas2" },
      },
      { tenantId: fabrikam, kind: "s3", role: "primary", name: "S3", config: { bucket: "nas" } },
    ]);
    instance = await import("./instance.js");
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
    Reflect.deleteProperty(process.env, "STORAGE_TARGET");
    Reflect.deleteProperty(process.env, "STORAGE_LOCAL_PATH");
  });

  it("finds every target of every tenant on a share, and nothing on another", async () => {
    const users = await instance.usersOf("/mnt/restow/nas");
    expect(users.map((user) => [user.tenantName, user.name, user.path]).sort()).toEqual([
      ["Contoso", "NAS", "/mnt/restow/nas/contoso"],
      ["Fabrikam", "Old", "/mnt/restow/nas"],
    ]);
    expect(await instance.usersOf("/mnt/restow/other")).toEqual([]);
  });

  it("finds the installation default from the environment", async () => {
    expect(await instance.usersOf("/mnt/restow/main")).toEqual([
      {
        kind: "installation_default",
        tenantId: null,
        tenantName: null,
        name: null,
        path: "/mnt/restow/main/chunks",
      },
    ]);
  });

  it("counts the running jobs of every tenant", async () => {
    expect(await instance.activeWork()).toEqual({ jobs: 0, endpointRuns: 0 });
    const [job] = await db
      .insert(jobs)
      .values([
        { tenantId: contoso, queue: "backup", status: "active" },
        { tenantId: fabrikam, queue: "restore", status: "queued" },
        { tenantId: fabrikam, queue: "verify", status: "completed" },
      ])
      .returning();
    expect(await instance.activeWork()).toEqual({ jobs: 1, endpointRuns: 0 });
    await db
      .update(jobs)
      .set({ status: "completed" })
      .where(eq(jobs.id, job?.id ?? ""));
    expect(await instance.activeWork()).toEqual({ jobs: 0, endpointRuns: 0 });
  });
});
