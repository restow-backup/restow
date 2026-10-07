/**
 * The notification recipients of a tenant take effect, against Postgres on the application role
 * (subject to Row Level Security): saving them changes who is mailed from the next alert on.
 *
 *   - each category with recipients is carried by one rule of the tenant; the worker's event
 *     fan-out (apps/worker/src/reporting.ts) queues a delivery for every address of the rules that
 *     list the event, so the proof ends at the outbox;
 *   - adding, removing and emptying follow, an address on two categories is mailed once per rule,
 *     and another tenant's recipients never mix in;
 *   - a rule an earlier release made for a category is taken over when it only holds known
 *     addresses, and left alone when an administrator added one of their own;
 *   - the addresses of such a rule cannot be edited on the rule, its other fields can;
 *   - the weekly report needs time-triggered reports, and a category nobody chose any more takes
 *     its rule away unless the rule still has a webhook to serve.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_recipients_test` is recreated there and dropped after).
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  providers,
  reportDeliveries,
  reportRules,
  tenantNotificationRecipients,
  tenants,
  user,
  webhooks,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../lib/tenant-context.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { Actor } from "../tenants/service.js";

const DATABASE = "restow_api_recipients_test";

type TenantsService = typeof import("../tenants/service.js");
type ReportsService = typeof import("./service.js");

describe.skipIf(!testDatabaseAdminUrl)(
  "notification recipients take effect against Postgres",
  () => {
    let owner: Database;
    let roles: TestDatabaseRoles | undefined;
    let shared: typeof import("../../db.js");
    let tenantsService: TenantsService;
    let reports: ReportsService;
    let raiseEvents: typeof import("../../../../worker/src/reporting.js").raiseEvents;
    let providerId = "";
    const actor: Actor = {
      id: randomUUID(),
      email: "admin@provider.example",
      ip: "192.0.2.10",
      isProviderAdmin: true,
    };
    const now = new Date("2026-10-02T10:00:00.000Z");

    beforeAll(async () => {
      const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
      roles = await provisionTestRoles(url);
      process.env.DATABASE_URL = roles.appUrl;
      process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
      process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
      owner = createDb(url);
      const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
      providerId = provider?.id ?? "";
      await owner
        .insert(user)
        .values({ id: actor.id, name: "Admin", email: actor.email, emailVerified: true });
      shared = await import("../../db.js");
      tenantsService = await import("../tenants/service.js");
      reports = await import("./service.js");
      ({ raiseEvents } = await import("../../../../worker/src/reporting.js"));
    }, 60_000);

    afterAll(async () => {
      if (shared) await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
      await owner?.$client.end();
      if (testDatabaseAdminUrl) {
        await dropDatabase(testDatabaseAdminUrl, DATABASE);
        await roles?.drop(testDatabaseAdminUrl);
      }
    }, 60_000);

    async function freshTenant(name: string, language: "de" | "en" | null = null): Promise<string> {
      const [row] = await owner
        .insert(tenants)
        .values({ providerId, name, slug: `t-${randomUUID().slice(0, 8)}`, language })
        .returning({ id: tenants.id });
      return row?.id ?? "";
    }

    const save = (
      tenantId: string,
      recipients: {
        email: string;
        categories: ("jobFailures" | "readinessRed" | "weeklyReport")[];
      }[],
    ) => tenantsService.replaceTenantNotificationRecipients(shared.db, tenantId, recipients, actor);

    const rulesOf = (tenantId: string) =>
      owner.select().from(reportRules).where(eq(reportRules.tenantId, tenantId));

    /** Raise `event` for the tenant and list the addresses the outbox now holds for it. */
    async function alert(tenantId: string, event: "backup.failed" | "verify.red", subject: string) {
      await withTenantTx(shared.db, tenantId, (tx) =>
        raiseEvents(
          tx,
          [
            {
              tenantId,
              level: "error",
              event,
              message: "x",
              details: { protectedObjectId: subject, objectName: subject },
            },
          ],
          new Date(),
        ),
      );
      const rows = await owner
        .select()
        .from(reportDeliveries)
        .where(
          and(
            eq(reportDeliveries.tenantId, tenantId),
            eq(reportDeliveries.event, event),
            eq(reportDeliveries.subjectKey, `object:${subject}`),
          ),
        );
      return rows
        .filter((row) => row.channel === "email")
        .map((row) => row.recipient)
        .sort();
    }

    it("carries each chosen category in one rule, and the alerts reach exactly those addresses", async () => {
      const tenant = await freshTenant("Contoso", "de");
      await save(tenant, [
        { email: "Anna@contoso.test", categories: ["jobFailures", "readinessRed"] },
        { email: "ben@contoso.test", categories: ["jobFailures"] },
      ]);
      const rules = await rulesOf(tenant);
      expect(
        rules.map((rule) => [rule.recipientCategory, rule.name, [...rule.emailRecipients].sort()]),
      ).toEqual(
        expect.arrayContaining([
          ["jobFailures", "Fehlgeschlagene Läufe", ["anna@contoso.test", "ben@contoso.test"]],
          ["readinessRed", "Wiederherstellbarkeit gefährdet", ["anna@contoso.test"]],
        ]),
      );
      // No weekly rule: time-triggered reports are not on in this test, and nobody chose it anyway.
      expect(rules).toHaveLength(2);

      expect(await alert(tenant, "backup.failed", "mailbox-1")).toEqual([
        "anna@contoso.test",
        "ben@contoso.test",
      ]);
      expect(await alert(tenant, "verify.red", "mailbox-1")).toEqual(["anna@contoso.test"]);
    }, 30_000);

    it("follows when a recipient is added, removed or no longer wants a category", async () => {
      const tenant = await freshTenant("Follows");
      await save(tenant, [
        { email: "one@x.test", categories: ["jobFailures"] },
        { email: "two@x.test", categories: ["jobFailures"] },
      ]);
      expect(await alert(tenant, "backup.failed", "m1")).toEqual(["one@x.test", "two@x.test"]);

      // two leaves, three arrives: the next alert goes to one and three only.
      await save(tenant, [
        { email: "one@x.test", categories: ["jobFailures"] },
        { email: "three@x.test", categories: ["jobFailures"] },
      ]);
      expect(await alert(tenant, "backup.failed", "m2")).toEqual(["one@x.test", "three@x.test"]);

      // one stops wanting failed jobs but wants readiness alerts instead.
      await save(tenant, [
        { email: "one@x.test", categories: ["readinessRed"] },
        { email: "three@x.test", categories: ["jobFailures"] },
      ]);
      expect(await alert(tenant, "backup.failed", "m3")).toEqual(["three@x.test"]);
      expect(await alert(tenant, "verify.red", "m3")).toEqual(["one@x.test"]);

      // Nobody left: the rules go, and an alert queues nothing.
      await save(tenant, []);
      expect(await rulesOf(tenant)).toEqual([]);
      expect(await alert(tenant, "backup.failed", "m4")).toEqual([]);
      expect(
        await owner
          .select()
          .from(tenantNotificationRecipients)
          .where(eq(tenantNotificationRecipients.tenantId, tenant)),
      ).toEqual([]);
    }, 30_000);

    it("never mixes in another tenant's recipients", async () => {
      const first = await freshTenant("Isolated one");
      const second = await freshTenant("Isolated two");
      await save(first, [{ email: "first@x.test", categories: ["jobFailures"] }]);
      await save(second, [{ email: "second@x.test", categories: ["jobFailures"] }]);
      expect(await alert(first, "backup.failed", "iso")).toEqual(["first@x.test"]);
      expect(await alert(second, "backup.failed", "iso")).toEqual(["second@x.test"]);
      await save(first, []);
      expect((await rulesOf(second)).map((rule) => rule.emailRecipients)).toEqual([
        ["second@x.test"],
      ]);
    }, 30_000);

    it("takes over a rule an earlier release made, but not one with an address of the administrator's own", async () => {
      const tenant = await freshTenant("Legacy");
      // What the wizard of an earlier release left behind: the recipients and a copy of them as a rule.
      await owner.insert(tenantNotificationRecipients).values([
        { tenantId: tenant, email: "old@x.test", notifyJobFailures: true },
        { tenantId: tenant, email: "older@x.test", notifyJobFailures: true },
      ]);
      await owner.insert(reportRules).values({
        tenantId: tenant,
        name: "Failed jobs",
        trigger: "event",
        events: ["backup.failed", "restore.failed", "archive.failed", "directory.failed"],
        emailRecipients: ["old@x.test", "older@x.test"],
        createdBy: "migration",
      });
      await save(tenant, [
        { email: "old@x.test", categories: ["jobFailures"] },
        { email: "new@x.test", categories: ["jobFailures"] },
      ]);
      const rules = await rulesOf(tenant);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({ name: "Failed jobs", recipientCategory: "jobFailures" });
      expect([...(rules[0]?.emailRecipients ?? [])].sort()).toEqual(["new@x.test", "old@x.test"]);
      expect(await alert(tenant, "backup.failed", "adopted")).toEqual(["new@x.test", "old@x.test"]);

      // A rule an administrator extended with their own address is theirs: it stays as it is and
      // the recipients get a rule of their own next to it.
      const custom = await freshTenant("Custom");
      await owner.insert(reportRules).values({
        tenantId: custom,
        name: "My alerts",
        trigger: "event",
        events: ["backup.failed", "restore.failed", "archive.failed", "directory.failed"],
        emailRecipients: ["stranger@x.test"],
        createdBy: actor.id,
      });
      await save(custom, [{ email: "mine@x.test", categories: ["jobFailures"] }]);
      const customRules = await rulesOf(custom);
      expect(customRules).toHaveLength(2);
      expect(customRules.find((rule) => rule.name === "My alerts")).toMatchObject({
        recipientCategory: null,
        emailRecipients: ["stranger@x.test"],
      });
    }, 30_000);

    it("refuses to edit the addresses of a rule that carries recipients, and accepts its other fields", async () => {
      const tenant = await freshTenant("Rule edits");
      await save(tenant, [{ email: "a@x.test", categories: ["jobFailures"] }]);
      const [rule] = await rulesOf(tenant);
      expect(rule?.recipientCategory).toBe("jobFailures");
      const dto = (await reports.listRules(shared.db, tenant))[0];
      expect(dto).toMatchObject({ recipientCategory: "jobFailures" });
      const admin = { userId: actor.id, label: actor.email, ip: null };

      await expect(
        reports.updateRule(
          shared.db,
          tenant,
          rule?.id ?? "",
          { emailRecipients: ["a@x.test", "b@x.test"] },
          admin,
          now,
        ),
      ).rejects.toMatchObject({ status: 422 });
      // The same list (in another case or order) is not a change.
      await reports.updateRule(
        shared.db,
        tenant,
        rule?.id ?? "",
        { emailRecipients: ["A@x.test"], throttleMinutes: 5 },
        admin,
        now,
      );
      const [after] = await rulesOf(tenant);
      expect(after).toMatchObject({ throttleMinutes: 5, emailRecipients: ["a@x.test"] });
    }, 30_000);

    it("keeps a rule that still has a webhook when its last address leaves", async () => {
      const tenant = await freshTenant("Webhook rule");
      await save(tenant, [{ email: "w@x.test", categories: ["readinessRed"] }]);
      const [hook] = await owner
        .insert(webhooks)
        .values({
          tenantId: tenant,
          url: "https://hooks.example.test/restow",
          events: ["job.failed"],
        })
        .returning({ id: webhooks.id });
      const [rule] = await rulesOf(tenant);
      await owner
        .update(reportRules)
        .set({ webhookId: hook?.id ?? null })
        .where(eq(reportRules.id, rule?.id ?? ""));
      await save(tenant, []);
      const left = await rulesOf(tenant);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ recipientCategory: "readinessRed", emailRecipients: [] });
    }, 30_000);

    it("audits the change with counts, never the addresses", async () => {
      const tenant = await freshTenant("Audited recipients");
      await save(tenant, [{ email: "secret@x.test", categories: ["jobFailures"] }]);
      const entry = (await owner.select().from(auditLog).where(eq(auditLog.tenantId, tenant))).find(
        (candidate) => candidate.action === "tenant.notification_recipients.updated",
      );
      expect(entry?.details).toMatchObject({
        count: 1,
        perCategory: { jobFailures: 1 },
        rules: { created: 1, updated: 0, adopted: 0, removed: 0 },
      });
      expect(JSON.stringify(entry?.details)).not.toContain("secret@x.test");
    }, 30_000);
  },
);
