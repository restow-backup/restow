/**
 * Postgres-backed proof that a real unique violation, as drizzle reports it,
 * is still recognised by `isUniqueViolation`. Since drizzle-orm 0.44 a failed
 * query rejects with a `DrizzleQueryError` whose `cause` is the driver error
 * carrying the SQLSTATE and constraint name; the helper must look through
 * that wrapper, also when the statement ran in a savepoint (as `bindSource`
 * does) and the outer transaction has to continue afterwards.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_unique_violation_test` is recreated there and dropped
 * after). Without it the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  ENTRA_TENANT_UNIQUE_INDEX,
  createDb,
  providers,
  sources,
  tenants,
} from "@restow/db";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { isUniqueViolation } from "./service.js";

const DATABASE = "restow_api_unique_violation_test";
const NAME_UNIQUE_INDEX = "sources_tenant_name_uq";

/** Resolve to the rejection of `run`, failing the test when it resolves instead. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the statement to fail");
}

describe.skipIf(!testDatabaseAdminUrl)("unique violations through drizzle against Postgres", () => {
  let db: Database;
  let tenantA: string;
  let tenantB: string;
  let sourceB: string;
  const entraTenantId = randomUUID();

  beforeAll(async () => {
    db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const created = await db
      .insert(tenants)
      .values(
        ["contoso", "fabrikam"].map((name) => ({
          providerId: provider?.id as string,
          name,
          slug: `${name}-${randomUUID().slice(0, 8)}`,
        })),
      )
      .returning();
    tenantA = created[0]?.id as string;
    tenantB = created[1]?.id as string;
    await db
      .insert(sources)
      .values({ tenantId: tenantA, kind: "m365", name: "M365", status: "active", entraTenantId });
    const [b] = await db
      .insert(sources)
      .values({ tenantId: tenantB, kind: "m365", name: "M365", status: "active" })
      .returning();
    sourceB = b?.id as string;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("recognises the violation behind drizzle's query error", async () => {
    const error = await rejectionOf(() =>
      db.insert(sources).values({ tenantId: tenantA, kind: "imap", name: "M365" }),
    );
    expect(error).toBeInstanceOf(DrizzleQueryError);
    expect(error).toHaveProperty("cause.code", "23505");
    expect(isUniqueViolation(error, NAME_UNIQUE_INDEX)).toBe(true);
    expect(isUniqueViolation(error, ENTRA_TENANT_UNIQUE_INDEX)).toBe(false);
  });

  it("recognises it from a savepoint and leaves the outer transaction usable", async () => {
    const outcome = await db.transaction(async (tx) => {
      const error = await rejectionOf(() =>
        tx.transaction(async (savepoint) => {
          await savepoint.update(sources).set({ entraTenantId }).where(eq(sources.id, sourceB));
        }),
      );
      const [row] = await tx
        .select({ entraTenantId: sources.entraTenantId })
        .from(sources)
        .where(eq(sources.id, sourceB));
      return { error, row };
    });
    expect(isUniqueViolation(outcome.error, ENTRA_TENANT_UNIQUE_INDEX)).toBe(true);
    expect(isUniqueViolation(outcome.error, NAME_UNIQUE_INDEX)).toBe(false);
    expect(outcome.row?.entraTenantId).toBeNull();
  });
});
