/**
 * Postgres-backed test of the provider's prices (0.4.7): nothing set reads as no price in EUR per
 * GB; a change merges into what is stored, null clears a price, the audit names before and after,
 * and the schema refuses what it does not know.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_pricing_test` is recreated there and dropped after, the roles with it).
 */
import { randomBytes } from "node:crypto";
import { auditLog, createDb, type Database, settings } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { pricingSchema, resolvePricing } from "./pricing.js";

const DATABASE = "restow_api_pricing_test";
const actor = { id: "provider-admin", email: "admin@provider.test", ip: "192.0.2.10" };

describe("resolvePricing", () => {
  it("takes nothing set as no price in EUR per GB, and drops what is not a price", () => {
    expect(resolvePricing({})).toEqual({
      currency: "EUR",
      storagePrice: null,
      storageUnit: "GB",
      mailboxPrice: null,
    });
    expect(
      resolvePricing({ currency: "XYZ", storagePrice: -1, mailboxPrice: Number.NaN }),
    ).toMatchObject({ currency: "EUR", storagePrice: null, mailboxPrice: null });
    expect(pricingSchema.safeParse({ storagePrice: 0.12345 }).success).toBe(false);
    expect(pricingSchema.safeParse({ storagePrice: -1 }).success).toBe(false);
    expect(pricingSchema.safeParse({ other: 1 }).success).toBe(false);
    expect(pricingSchema.safeParse({ storagePrice: 0.025, storageUnit: "TB" }).success).toBe(true);
  });
});

describe.skipIf(!testDatabaseAdminUrl)("the provider's prices against Postgres", () => {
  let db: Database;
  let roles: TestDatabaseRoles | undefined;
  let providerDb: Database;
  let pricing: typeof import("./pricing.js");

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    db = createDb(url);
    pricing = await import("./pricing.js");
    providerDb = (await import("../../db.js")).providerDb;
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  it("refuses a change before the setup, then merges, clears and audits", async () => {
    await expect(
      pricing.updatePricing(providerDb, { mailboxPrice: 2 }, actor),
    ).rejects.toMatchObject({ status: 409 });
    await db.insert(settings).values({});
    expect(await pricing.getPricing(providerDb)).toMatchObject({ storagePrice: null });
    await pricing.updatePricing(providerDb, { mailboxPrice: 2.5, currency: "CHF" }, actor);
    const saved = await pricing.updatePricing(
      providerDb,
      { storagePrice: 25, storageUnit: "TB" },
      actor,
    );
    expect(saved).toEqual({
      currency: "CHF",
      storagePrice: 25,
      storageUnit: "TB",
      mailboxPrice: 2.5,
    });
    const cleared = await pricing.updatePricing(providerDb, { mailboxPrice: null }, actor);
    expect(cleared.mailboxPrice).toBeNull();
    expect(await pricing.getPricing(providerDb)).toEqual(cleared);
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.pricing.updated"));
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.tenantId === null)).toBe(true);
  });
});
