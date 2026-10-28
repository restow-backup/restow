/**
 * Postgres-backed tests of the central app's expiry reminder (secret-watch.ts): one reminder
 * per stage and date (30 days, 7 days, expired) in the bell without a tenant and in every
 * tenant's rule that lists the event, nothing on a repeated check, a new date starting over,
 * and the subject keys that keep each stage apart in a rule's throttle.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_secret_watch_test` is recreated there and dropped after). Without it the suite
 * is skipped.
 */
import { randomBytes } from "node:crypto";
import type { EntraAppResolution, ResolvedEntraApp } from "@restow/core";
import {
  createDb,
  type Database,
  notifications,
  providers,
  reportDeliveries,
  reportRules,
  settings,
  tenants,
} from "@restow/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_secret_watch_test";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const DAY = 24 * 60 * 60 * 1000;
const EXPIRES = "2026-12-01T00:00:00.000Z";

type WatchModule = typeof import("./secret-watch.js");

function ready(expiresAt: string | null, over: Partial<ResolvedEntraApp> = {}): EntraAppResolution {
  return {
    status: "ready",
    app: {
      source: "database",
      credentials: {
        clientId: CLIENT_ID,
        credential: { type: "secret", clientSecret: "not-used" },
      },
      credentialKind: "secret",
      expiresAt,
      certificate: null,
      homeTenantId: null,
      updatedAt: null,
      updatedBy: null,
      fingerprint: "fp",
      ...over,
    },
  };
}

describe.skipIf(!testDatabaseAdminUrl)("the central app's expiry reminder against Postgres", () => {
  let owner: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let watchModule: WatchModule;
  let contoso: string;
  let resolution: EntraAppResolution;

  function watch(now: Date) {
    return new watchModule.SecretWatch({
      db: providerDb,
      resolve: async () => resolution,
      now: () => now,
    });
  }

  /** 10:00 UTC on the day `days` calendar days before EXPIRES; negative is after it. */
  const before = (days: number, expiresAt = EXPIRES) =>
    new Date(Date.parse(expiresAt) - days * DAY + 10 * 60 * 60 * 1000);

  const bell = () =>
    owner
      .select()
      .from(notifications)
      .where(eq(notifications.event, "installation.app_secret_expiring"))
      .orderBy(asc(notifications.createdAt));

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    providerDb = createDb(roles.providerUrl);
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    contoso = tenant?.id ?? "";
    watchModule = await import("./secret-watch.js");
  }, 60_000);

  afterAll(async () => {
    await Promise.all([owner?.$client.end(), providerDb?.$client.end()]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  beforeEach(async () => {
    await owner.delete(reportDeliveries);
    await owner.delete(reportRules);
    await owner.delete(notifications);
    await owner.delete(settings);
    await owner.insert(settings).values({ singleton: true, operatingMode: "public" });
    await owner.insert(reportRules).values({
      tenantId: contoso,
      name: "App secret",
      trigger: "event",
      events: ["installation.app_secret_expiring"],
      emailRecipients: ["ops@example.com"],
    });
    resolution = ready(EXPIRES);
  });

  it("raises once at 30 days, once at 7 days and once when expired", async () => {
    // Far away: nothing.
    expect(await watch(before(45)).checkOnce()).toEqual({ status: "ok", expiresAt: EXPIRES });
    expect(await bell()).toHaveLength(0);

    expect(await watch(before(30)).checkOnce()).toEqual({
      status: "raised",
      stage: "soon30",
      expiresAt: EXPIRES,
    });
    // Repeated checks in the same stage raise nothing.
    expect((await watch(before(29)).checkOnce()).status).toBe("alerted");
    expect((await watch(before(8)).checkOnce()).status).toBe("alerted");

    expect(await watch(before(7)).checkOnce()).toMatchObject({ status: "raised", stage: "soon7" });
    expect((await watch(before(1)).checkOnce()).status).toBe("alerted");

    expect(await watch(before(-1)).checkOnce()).toMatchObject({
      status: "raised",
      stage: "expired",
    });
    expect((await watch(before(-5)).checkOnce()).status).toBe("alerted");

    const rows = await bell();
    expect(rows.map((row) => [row.tenantId, row.level, row.details])).toEqual([
      [null, "warning", expect.objectContaining({ stage: "soon30", days: 30 })],
      [null, "warning", expect.objectContaining({ stage: "soon7", days: 7 })],
      [null, "error", expect.objectContaining({ stage: "expired" })],
    ]);
    expect(rows[0]?.details).toMatchObject({
      clientId: CLIENT_ID,
      source: "database",
      credentialKind: "secret",
      expiresAt: EXPIRES,
      objectName: CLIENT_ID,
    });

    // One delivery per stage, each with its own subject key (the throttle keeps them apart).
    const deliveries = await owner
      .select()
      .from(reportDeliveries)
      .orderBy(asc(reportDeliveries.createdAt));
    expect(deliveries.map((delivery) => delivery.subjectKey)).toEqual([
      `entra_app:${EXPIRES}:soon30`,
      `entra_app:${EXPIRES}:soon7`,
      `entra_app:${EXPIRES}:expired`,
    ]);
    expect(
      deliveries.every((delivery) => delivery.event === "installation.app_secret_expiring"),
    ).toBe(true);

    const [row] = await owner.select({ alerts: settings.appSecretAlerts }).from(settings);
    expect(row?.alerts.central).toMatchObject({ expiresAt: EXPIRES, stage: "expired" });
  });

  it("raises only the stage it first sees, without catching up earlier ones", async () => {
    expect(await watch(before(5)).checkOnce()).toMatchObject({ status: "raised", stage: "soon7" });
    expect((await watch(before(4)).checkOnce()).status).toBe("alerted");
    expect((await bell()).map((row) => (row.details as { stage: string }).stage)).toEqual([
      "soon7",
    ]);
  });

  it("treats another spelling of the same date as the same, and starts over for a new date", async () => {
    expect((await watch(before(6)).checkOnce()).status).toBe("raised");
    // The same instant written as a calendar date counts as the same date.
    resolution = ready("2026-12-01");
    expect((await watch(before(6)).checkOnce()).status).toBe("alerted");

    // A rotated secret with a new date, again inside 30 days: a new reminder.
    const renewed = "2026-12-20T00:00:00.000Z";
    resolution = ready(renewed);
    expect(await watch(before(25, renewed)).checkOnce()).toEqual({
      status: "raised",
      stage: "soon30",
      expiresAt: renewed,
    });
    expect(await bell()).toHaveLength(2);
    const [row] = await owner.select({ alerts: settings.appSecretAlerts }).from(settings);
    expect(row?.alerts.central).toMatchObject({ expiresAt: renewed, stage: "soon30" });
  });

  it("starts over for another registration with the same date, not for a legacy mark", async () => {
    expect(await watch(before(6)).checkOnce()).toMatchObject({ status: "raised", stage: "soon7" });
    const [marked] = await owner.select({ alerts: settings.appSecretAlerts }).from(settings);
    expect(marked?.alerts.central).toMatchObject({
      expiresAt: EXPIRES,
      stage: "soon7",
      clientId: CLIENT_ID,
      source: "database",
    });

    // The environment's registration of the same app now applies: its own reminders.
    resolution = ready(EXPIRES, { source: "environment" });
    expect(await watch(before(6)).checkOnce()).toMatchObject({ status: "raised", stage: "soon7" });
    // Another app whose secret ends on the same day: its own reminders too.
    const other = "99999999-8888-4777-8666-555555555555";
    resolution = ready(EXPIRES, {
      source: "environment",
      credentials: { clientId: other, credential: { type: "secret", clientSecret: "x" } },
    });
    expect(await watch(before(6)).checkOnce()).toMatchObject({ status: "raised", stage: "soon7" });
    expect((await watch(before(5)).checkOnce()).status).toBe("alerted");
    expect((await bell()).map((row) => (row.details as { clientId: string }).clientId)).toEqual([
      CLIENT_ID,
      CLIENT_ID,
      other,
    ]);

    // A mark written before the registration was kept in it counts as the current one's.
    await owner.update(settings).set({
      appSecretAlerts: {
        central: { expiresAt: EXPIRES, stage: "soon7", at: "2026-11-24T00:00:00.000Z" },
      },
    });
    resolution = ready(EXPIRES);
    expect((await watch(before(5)).checkOnce()).status).toBe("alerted");
    expect(await bell()).toHaveLength(3);
  });

  it("covers a certificate by its notAfter, and records nothing without a date", async () => {
    resolution = ready(null);
    expect(await watch(before(3)).checkOnce()).toEqual({ status: "unknown" });
    resolution = { status: "none", clientId: null };
    expect(await watch(before(3)).checkOnce()).toEqual({ status: "unknown" });
    expect(await bell()).toHaveLength(0);
    const [empty] = await owner.select({ alerts: settings.appSecretAlerts }).from(settings);
    expect(empty?.alerts).toEqual({});

    resolution = ready(EXPIRES, { credentialKind: "certificate", source: "environment" });
    expect((await watch(before(3)).checkOnce()).status).toBe("raised");
    const [first] = await bell();
    expect(first?.details).toMatchObject({ credentialKind: "certificate", source: "environment" });
    expect(first?.message).toContain("certificate");
  });
});
