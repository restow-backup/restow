/**
 * Postgres-backed test of marking the notification mail as not needed (the
 * Start checklist's "Not needed"): the flag on the settings row, the entry in
 * the installation audit chain, and that asking for what is already stored
 * writes nothing.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_mailnotneeded_test` is recreated there
 * and dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import { type Database, auditLog, createDb, settings } from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_mailnotneeded_test";
const actor = { id: "provider-admin", email: "admin@provider.test", ip: "192.0.2.10" };

describe.skipIf(!testDatabaseAdminUrl)("mail marked as not needed against Postgres", () => {
  let db: Database;
  let roles: TestDatabaseRoles | undefined;
  let service: typeof import("./service.js");
  let providerDb: Database;

  const marked = async () => (await db.select().from(settings))[0]?.mailNotNeeded;
  const entries = () =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "settings.mail.not_needed"), isNull(auditLog.tenantId)));

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    db = createDb(url);
    service = await import("./service.js");
    providerDb = (await import("../../db.js")).providerDb;
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  it("refuses before the setup is complete", async () => {
    await expect(service.setMailNotNeeded(providerDb, true, actor)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("is off by default, turns on and off, and records each change in the installation chain", async () => {
    await db.insert(settings).values({ singleton: true, operatingMode: "local" });
    expect(await marked()).toBe(false);

    expect(await service.setMailNotNeeded(providerDb, true, actor)).toEqual({ notNeeded: true });
    expect(await marked()).toBe(true);
    expect(await service.setMailNotNeeded(providerDb, false, actor)).toEqual({ notNeeded: false });
    expect(await marked()).toBe(false);

    const log = await entries();
    expect(log.map((entry) => (entry.details as { notNeeded: boolean }).notNeeded)).toEqual([
      true,
      false,
    ]);
    expect(log[0]).toMatchObject({ actor: actor.email, targetType: "settings", ip: actor.ip });
  });

  it("writes nothing when the mark already is what was asked for", async () => {
    const before = (await entries()).length;
    await service.setMailNotNeeded(providerDb, false, actor);
    expect((await entries()).length).toBe(before);
  });
});
