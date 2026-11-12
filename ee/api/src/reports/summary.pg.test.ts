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
  createDb,
  type Database,
  license,
  notifications,
  providers,
  reportDeliveries,
  reportRules,
  settings,
  tenantContacts,
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
  provisionTestRoles,
  type TestDatabaseRoles,
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
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
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

  it("creates a rule with a calendar cadence, exclusive of an own cron (0.5.0)", async () => {
    const { createRule } = await import("../../../../apps/api/src/features/reports/service.js");
    const actor = { userId: randomUUID(), label: "admin@kanzlei.test", ip: null };
    const base = {
      trigger: "schedule" as const,
      name: "Monatsbericht",
      enabled: true,
      events: [],
      throttleMinutes: 60,
      intervalMinutes: null,
      timezone: "Europe/Berlin",
      periodDays: 7,
      sections: ["backups" as const],
      emailRecipients: ["it@kanzlei.test"],
      inApp: false,
      webhookId: null,
      language: null,
    };
    const now = new Date("2026-09-30T10:00:00Z");
    const rule = await createRule(
      appDb,
      contoso,
      { ...base, cron: null, cadence: "monthly", attachPdf: true },
      actor,
      now,
    );
    expect(rule).toMatchObject({
      cadence: "monthly",
      cron: "0 7 1 * *",
      attachPdf: true,
      kind: "summary",
      nextRunAt: "2026-10-01T05:00:00.000Z",
      deliveryProblems: [],
    });
    await expect(
      createRule(appDb, contoso, { ...base, cron: "0 7 * * 1", cadence: "weekly" }, actor, now),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("builds nothing for another tenant's rule id", async () => {
    const { testRule } = await import("../../../../apps/api/src/features/reports/service.js");
    await expect(
      testRule(appDb, contoso, randomUUID(), { userId: null, label: "x", ip: null }, new Date()),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("sends the provider's report across tenants with the PDF statistics (0.5.0)", async () => {
    const { dispatchOnce } = await import(
      "../../../../apps/api/src/features/reports/dispatcher.js"
    );
    await owner
      .insert(settings)
      .values({ singleton: true, operatingMode: "public" })
      .onConflictDoNothing();
    const now = new Date("2026-10-05T05:01:00Z");
    const [row] = await owner
      .insert(reportDeliveries)
      .values({
        tenantId: null,
        ruleName: "Wochenbericht",
        kind: "summary",
        payload: {
          scope: "provider",
          cadence: "weekly",
          periodStart: "2026-09-27T22:00:00.000Z",
          periodEnd: "2026-10-04T22:00:00.000Z",
          fromDay: "2026-09-28",
          toDay: "2026-10-04",
          attachPdf: true,
        },
        channel: "email",
        recipient: "olivia@msp.example",
        status: "pending",
        nextAttemptAt: now,
      })
      .returning();
    const notifier = new RecordingNotifier();
    await dispatchOnce({ providerDb, db: appDb, notifier: async () => notifier, now: () => now });
    const [after] = await owner
      .select()
      .from(reportDeliveries)
      .where(eq(reportDeliveries.id, row?.id ?? ""));
    expect(after?.status, after?.lastError ?? "").toBe("sent");
    const mail = notifier.sent[0];
    expect(mail?.subject).toBe("[Installation] Wochenbericht");
    expect(mail?.text).toContain("Mandanten: 1");
    const pdf = mail?.attachments?.find((file) => file.contentType === "application/pdf");
    expect(pdf?.filename).toBe("summary-2026-09-28-2026-10-04.pdf");
    expect(pdf?.content.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("sends the customer monthly report in Service Provider only (0.5.0)", async () => {
    const reports = await import("../../../../apps/api/src/features/reports/customer-report.js");
    const { dispatchOnce } = await import(
      "../../../../apps/api/src/features/reports/dispatcher.js"
    );
    const actor = { id: randomUUID(), email: "olivia@msp.example", ip: null };
    await owner.insert(tenantContacts).values({
      tenantId: contoso,
      name: "Kunde",
      email: "chef@kanzlei.test",
      isPrimary: true,
      monthlyReport: true,
    });
    // Business: not offered.
    await expect(
      reports.putCustomerReport(appDb, providerDb, contoso, { enabled: true }, actor),
    ).rejects.toMatchObject({ status: 403 });
    await owner.update(license).set({ edition: "service_provider" });
    try {
      const dto = await reports.putCustomerReport(
        appDb,
        providerDb,
        contoso,
        { enabled: true, sendDay: 3, sendHour: 8 },
        actor,
        new Date("2026-10-10T10:00:00Z"),
      );
      expect(dto).toMatchObject({
        available: true,
        enabled: true,
        sendDay: 3,
        sendHour: 8,
        recipients: [{ name: "Kunde", email: "chef@kanzlei.test" }],
        nextRunAt: "2026-11-03T07:00:00.000Z",
      });
      const now = new Date("2026-11-03T07:00:30Z");
      expect(await reports.sendCustomerReportTest(appDb, providerDb, contoso, actor, now)).toEqual({
        to: "olivia@msp.example",
      });
      const notifier = new RecordingNotifier();
      await dispatchOnce({ providerDb, db: appDb, notifier: async () => notifier, now: () => now });
      const mail = notifier.sent.find((sent) => sent.to === "olivia@msp.example");
      expect(mail?.subject).toContain("Test:");
      const pdf = mail?.attachments?.find((file) => file.contentType === "application/pdf");
      expect(pdf?.filename).toBe("report-2026-10.pdf");
      expect(pdf?.content.subarray(0, 5).toString()).toBe("%PDF-");
      const preview = await reports.previewCustomerReportPdf(appDb, providerDb, contoso, {
        month: "2026-10",
      });
      expect(preview.pdf.subarray(0, 5).toString()).toBe("%PDF-");
      // The report follows the contacts that receive it.
      const { replaceTenantContacts } = await import(
        "../../../../apps/api/src/features/tenants/service.js"
      );
      await replaceTenantContacts(
        appDb,
        contoso,
        [
          { name: "Kunde", email: "chef@kanzlei.test", isPrimary: true, monthlyReport: false },
          { name: "IT", email: "it@kanzlei.test", isPrimary: false, monthlyReport: true },
        ],
        { ...actor, isProviderAdmin: true } as never,
      );
      expect((await reports.getCustomerReport(appDb, providerDb, contoso)).recipients).toEqual([
        expect.objectContaining({ email: "it@kanzlei.test" }),
      ]);
      const [rule] = await owner
        .select({ emailRecipients: reportRules.emailRecipients })
        .from(reportRules)
        .where(eq(reportRules.recipientCategory, "customerReport"));
      expect(rule?.emailRecipients).toEqual(["it@kanzlei.test"]);
    } finally {
      await owner.update(license).set({ edition: "business" });
    }
    // After the downgrade a queued customer report is skipped, not sent.
    const now = new Date("2026-11-03T08:00:00Z");
    await owner.insert(reportDeliveries).values({
      tenantId: contoso,
      ruleName: "Kundenbericht",
      kind: "summary",
      payload: { kind: "customer", month: "2026-10", attachPdf: true },
      channel: "email",
      recipient: "chef@kanzlei.test",
      status: "pending",
      nextAttemptAt: now,
    });
    await dispatchOnce({
      providerDb,
      db: appDb,
      notifier: async () => new RecordingNotifier(),
      now: () => now,
    });
    const skipped = await owner
      .select()
      .from(reportDeliveries)
      .where(eq(reportDeliveries.recipient, "chef@kanzlei.test"));
    expect(skipped.map((row) => [row.status, row.lastError])).toEqual([
      ["skipped", "not_available"],
    ]);
  });
});
