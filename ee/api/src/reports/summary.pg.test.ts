/**
 * Summary reports of the Business edition against Postgres: a time-triggered
 * rule can be created once the license is Business, and a queued report is
 * rendered from the same statistics code as the statistics page and sent by
 * mail and to the bell, through the core dispatcher with this module's hook.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_ee_reports_test` is recreated there).
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  createDb,
  license,
  notifications,
  providers,
  reportDeliveries,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import type { NotificationMessage, Notifier } from "../../../../apps/api/src/notify.js";
import {
  type TestDatabaseRoles,
  provisionTestRoles,
} from "../../../../apps/api/src/testing/database-roles.js";

const DATABASE = "restow_ee_reports_test";

class RecordingNotifier implements Notifier {
  readonly sent: NotificationMessage[] = [];
  async send(message: NotificationMessage) {
    this.sent.push(message);
    return { ok: true };
  }
  async sendTest() {
    return { ok: true };
  }
}

describe.skipIf(!testDatabaseAdminUrl)("summary reports (Business) against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let contoso: string;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Kanzlei", slug: "kanzlei", language: "de" })
      .returning();
    contoso = tenant?.id ?? "";
    await owner.insert(license).values({
      edition: "business",
      active: true,
      installationId: "test-installation",
    });

    const { registerApiExtension } = await import("../../../../apps/api/src/extensions.js");
    const { reportsExtensionHooks } = await import("./summary.js");
    const { licenseFeatureGate } = await import("../license/gate.js");
    registerApiExtension({
      name: "ee-reports-test",
      hooks: reportsExtensionHooks,
      featureGate: licenseFeatureGate,
    });
  }, 60_000);

  afterAll(async () => {
    const { resetExtensionsForTesting } = await import("../../../../apps/api/src/extensions.js");
    resetExtensionsForTesting();
    const shared = await import("../../../../apps/api/src/db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await Promise.all([appDb?.$client.end(), providerDb?.$client.end(), owner?.$client.end()]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (roles) await roles.drop(testDatabaseAdminUrl as string);
  }, 60_000);

  it("creates a weekly report and sends it by mail and to the bell", async () => {
    const { createRule, testRule } = await import(
      "../../../../apps/api/src/features/reports/service.js"
    );
    const { dispatchOnce } = await import(
      "../../../../apps/api/src/features/reports/dispatcher.js"
    );
    const now = new Date("2026-09-30T10:00:00Z");
    const actor = { userId: randomUUID(), label: "admin@kanzlei.test", ip: null };
    const rule = await createRule(
      appDb,
      contoso,
      {
        trigger: "schedule",
        name: "Wochenbericht",
        enabled: true,
        events: [],
        throttleMinutes: 60,
        cron: "0 7 * * 1",
        intervalMinutes: null,
        timezone: "Europe/Berlin",
        periodDays: 7,
        sections: ["backups", "readiness", "failures", "storage", "restores"],
        emailRecipients: ["it@kanzlei.test"],
        inApp: true,
        webhookId: null,
        language: null,
      },
      actor,
      now,
    );
    expect(rule).toMatchObject({ locked: false, nextRunAt: "2026-10-05T05:00:00.000Z" });

    expect(await testRule(appDb, contoso, rule.id, actor, now)).toEqual({ queued: 2 });
    const notifier = new RecordingNotifier();
    await dispatchOnce({ providerDb, db: appDb, notifier: async () => notifier, now: () => now });

    const rows = await owner
      .select()
      .from(reportDeliveries)
      .where(eq(reportDeliveries.ruleId, rule.id));
    expect(rows.map((row) => [row.channel, row.status])).toEqual(
      expect.arrayContaining([
        ["email", "sent"],
        ["in_app", "sent"],
      ]),
    );
    expect(notifier.sent).toHaveLength(1);
    const mail = notifier.sent[0];
    expect(mail?.subject).toBe("[Kanzlei] Test: Wochenbericht");
    // German labels, every chosen section, and honest empty values for a tenant with no data.
    for (const label of [
      "Erfolgsquote der Sicherungen",
      "Nachweislich wiederherstellbar",
      "Keine in diesem Zeitraum",
      "Geschützte Daten",
      "Wiederherstellungen",
    ]) {
      expect(mail?.text).toContain(label);
    }
    const bell = await owner
      .select()
      .from(notifications)
      .where(eq(notifications.tenantId, contoso));
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ event: "report.ready" });
    expect(bell[0]?.details).toMatchObject({ ruleName: "Wochenbericht" });
  });

  it("builds nothing for another tenant's rule id", async () => {
    const { testRule } = await import("../../../../apps/api/src/features/reports/service.js");
    await expect(
      testRule(appDb, contoso, randomUUID(), { userId: null, label: "x", ip: null }, new Date()),
    ).rejects.toMatchObject({ status: 404 });
  });
});
