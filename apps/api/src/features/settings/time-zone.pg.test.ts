/**
 * Postgres-backed test of the installation's time zone (0.4.2): chosen on the settings row,
 * read back with where it comes from, taken back to the environment's, audited in the
 * installation chain, and nothing written when nothing changes.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_timezone_test` is recreated there and dropped after, the roles with it). Without it
 * the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import { auditLog, createDb, type Database, settings } from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { timeZoneSettingSchema } from "./schemas.js";

const DATABASE = "restow_api_timezone_test";
const actor = { id: "provider-admin", email: "admin@provider.test", ip: "192.0.2.10" };
const context = { observedOrigin: null };

describe.skipIf(!testDatabaseAdminUrl)("the installation's time zone against Postgres", () => {
  let db: Database;
  let roles: TestDatabaseRoles | undefined;
  let service: typeof import("./service.js");
  let providerDb: Database;
  const previous = { restow: process.env.RESTOW_TIME_ZONE, tz: process.env.TZ };

  const entries = () =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "settings.time_zone.changed"), isNull(auditLog.tenantId)));

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.RESTOW_TIME_ZONE = "Europe/Vienna";
    db = createDb(url);
    service = await import("./service.js");
    providerDb = (await import("../../db.js")).providerDb;
  }, 60_000);

  afterAll(async () => {
    for (const [name, value] of [
      ["RESTOW_TIME_ZONE", previous.restow],
      ["TZ", previous.tz],
    ] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
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

  it("refuses before the setup is complete", async () => {
    await expect(
      service.setInstallationTimeZone(providerDb, { timeZone: "UTC" }, actor, context),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("uses RESTOW_TIME_ZONE until a zone is chosen, then the chosen one", async () => {
    await db.insert(settings).values({ singleton: true, operatingMode: "local" });
    const before = await service.getSettings(providerDb, context);
    expect(before.timeZone).toEqual({
      timeZone: "Europe/Vienna",
      source: "environment",
      stored: null,
      environment: { timeZone: "Europe/Vienna", source: "environment" },
    });

    const input = timeZoneSettingSchema.parse({ timeZone: "america/new_york" });
    expect(input.timeZone).toBe("America/New_York");
    const after = await service.setInstallationTimeZone(providerDb, input, actor, context);
    expect(after.timeZone).toMatchObject({
      timeZone: "America/New_York",
      source: "settings",
      stored: "America/New_York",
      environment: { timeZone: "Europe/Vienna" },
    });
    expect(await loadInstallationTimeZone(providerDb)).toEqual({
      timeZone: "America/New_York",
      source: "settings",
    });

    const log = await entries();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: actor.email, targetType: "settings", ip: actor.ip });
    expect(log[0]?.details).toMatchObject({
      from: null,
      to: "America/New_York",
      effective: "America/New_York",
      source: "settings",
    });
  });

  it("writes nothing when the zone already is the chosen one", async () => {
    await service.setInstallationTimeZone(
      providerDb,
      { timeZone: "America/New_York" },
      actor,
      context,
    );
    expect(await entries()).toHaveLength(1);
  });

  it("takes the choice back, so the environment applies again", async () => {
    const view = await service.setInstallationTimeZone(
      providerDb,
      { timeZone: null },
      actor,
      context,
    );
    expect(view.timeZone).toMatchObject({ timeZone: "Europe/Vienna", stored: null });
    const log = await entries();
    expect(log.at(-1)?.details).toMatchObject({
      from: "America/New_York",
      to: null,
      effective: "Europe/Vienna",
      source: "environment",
    });
  });

  it("refuses names that are no IANA zones", () => {
    for (const timeZone of ["Mars/Base", "+02:00", "", "Europe/Berlin; drop"]) {
      expect(timeZoneSettingSchema.safeParse({ timeZone }).success).toBe(false);
    }
    expect(timeZoneSettingSchema.safeParse({ timeZone: "UTC", extra: 1 }).success).toBe(false);
  });
});
