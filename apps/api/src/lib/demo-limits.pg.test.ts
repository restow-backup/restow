/**
 * `assertDemoJobNotInFlight` against real rows: whether a tenant already has
 * a queued/active job of a queue depends on the actual `jobs` table state, so
 * this is exercised against Postgres rather than a mocked query builder.
 *
 * The database `restow_api_demo_limits_test` is created once and migrated in
 * `beforeAll`, like every other `*.pg.test.ts` suite in this repository
 * (recreating and re-migrating it per test, as an earlier version of this
 * file did, took long enough under load to flake against the default 5s test
 * timeout); `afterEach` clears `jobs` and the second tenant instead, so every
 * test still starts from a clean slate. Runs when RESTOW_TEST_DATABASE_URL
 * points at a Postgres server; without it the suite is skipped.
 */
import { type Database, createDb, jobs, providers, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../features/snapshots/testing/explorer-fixture.js";
import { ProblemError } from "../problem.js";
import { assertDemoJobNotInFlight, isDemoJobInFlight } from "./demo-limits.js";

const DATABASE = "restow_api_demo_limits_test";

describe.skipIf(!testDatabaseAdminUrl)("assertDemoJobNotInFlight against Postgres", () => {
  let db: Database;
  let tenantId: string;

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Demo", slug: "demo" })
      .returning();
    tenantId = tenant?.id as string;
  }, 30_000);

  afterEach(async () => {
    await db.delete(jobs);
    await db.delete(tenants).where(eq(tenants.slug, "other"));
  });

  afterAll(async () => {
    await db.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("passes when the tenant has no job of that queue at all", async () => {
    await expect(assertDemoJobNotInFlight(db, tenantId, "backup")).resolves.toBeUndefined();
  });

  it("passes when every job of that queue already finished", async () => {
    await db.insert(jobs).values([
      { tenantId, queue: "backup", status: "completed" },
      { tenantId, queue: "backup", status: "failed" },
      { tenantId, queue: "backup", status: "cancelled" },
    ]);
    await expect(assertDemoJobNotInFlight(db, tenantId, "backup")).resolves.toBeUndefined();
  });

  it("refuses when a job of that queue is queued or active", async () => {
    await db.insert(jobs).values({ tenantId, queue: "verify", status: "queued" });
    const error = await assertDemoJobNotInFlight(db, tenantId, "verify").catch((e) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect((error as ProblemError).status).toBe(409);
    expect((error as ProblemError).type).toBe("urn:restow:problem:demo-job-in-progress");
  });

  it("answers the same question without throwing (isDemoJobInFlight)", async () => {
    expect(await isDemoJobInFlight(db, tenantId, "backup")).toBe(false);
    await db.insert(jobs).values({ tenantId, queue: "backup", status: "completed" });
    expect(await isDemoJobInFlight(db, tenantId, "backup")).toBe(false);
    await db.insert(jobs).values({ tenantId, queue: "backup", status: "active" });
    expect(await isDemoJobInFlight(db, tenantId, "backup")).toBe(true);
    expect(await isDemoJobInFlight(db, tenantId, "verify")).toBe(false);
  });

  it("only looks at the named queue and the named tenant", async () => {
    const [provider] = await db.select().from(providers);
    const [other] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Other", slug: "other" })
      .returning();
    await db.insert(jobs).values([
      { tenantId, queue: "restore", status: "active" },
      { tenantId: other?.id as string, queue: "backup", status: "active" },
    ]);
    // A different queue on the same tenant does not block backup...
    await expect(assertDemoJobNotInFlight(db, tenantId, "backup")).resolves.toBeUndefined();
    // ...and the other tenant's in-flight backup does not block this one either.
    await expect(assertDemoJobNotInFlight(db, tenantId, "backup")).resolves.toBeUndefined();
  });
});
