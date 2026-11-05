/**
 * Postgres-backed tests of the 0.5.0 notification package: the provider's recipients and the
 * floor, the fan-out to them (Row Level Security keeps their rows from every tenant), digests,
 * and the alerts about failed deliveries (episodes, the failing channel left out, no loop).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_notifications_050_test` is recreated there and dropped after). Without it the suite
 * is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { MAX_REPORT_ATTEMPTS } from "@restow/core";
import {
  createDb,
  type Database,
  notifications,
  providerMembers,
  providerNotificationRecipients,
  providers,
  type ReportDelivery,
  raiseReportEvents,
  reportDeliveries,
  reportEvents,
  reportRules,
  settings,
  tenantNotificationRecipients,
  tenants,
  user,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationMessage, Notifier, NotifyResult } from "../../notify.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_notifications_050_test";

/** A notifier that answers per address. */
class ScriptedNotifier implements Notifier {
  readonly sent: NotificationMessage[] = [];
  answer: (message: NotificationMessage) => NotifyResult = () => ({ ok: true });
  async send(message: NotificationMessage) {
    const result = this.answer(message);
    if (result.ok) this.sent.push(message);
    return result;
  }
  async sendTest() {
    return { ok: true };
  }
}

describe.skipIf(!testDatabaseAdminUrl)(
  "notification recipients, digests and delivery failures",
  () => {
    let owner: Database;
    let appDb: Database;
    let providerDb: Database;
    let roles: TestDatabaseRoles | undefined;
    let contoso: string;
    let hookId: string;
    const ownerId = randomUUID();
    const adminId = randomUUID();
    const notifier = new ScriptedNotifier();
    let clock = new Date("2026-09-30T10:15:00.000Z");
    // biome-ignore lint/suspicious/noExplicitAny: the modules are imported once the env is set
    let mod: any;

    const deps = () => ({
      providerDb,
      db: appDb,
      notifier: async () => notifier,
      now: () => clock,
    });

    beforeAll(async () => {
      const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
      roles = await provisionTestRoles(url);
      process.env.DATABASE_URL = roles.appUrl;
      process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
      process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
      process.env.RESTOW_TIME_ZONE = "Europe/Berlin";
      owner = createDb(url);
      appDb = createDb(roles.appUrl);
      providerDb = createDb(roles.providerUrl);
      mod = {
        dispatcher: await import("./dispatcher.js"),
        fanout: await import("./fanout.js"),
        recipients: await import("../provider-notifications/service.js"),
        updates: await import("../updates/notify.js"),
        context: await import("../../lib/tenant-context.js"),
      };

      const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
      await owner.insert(settings).values({ singleton: true, operatingMode: "public" });
      await owner.insert(user).values([
        {
          id: ownerId,
          name: "Olivia Owner",
          email: "olivia@msp.example",
          role: "admin",
          emailVerified: true,
        },
        {
          id: adminId,
          name: "Adam Admin",
          email: "adam@msp.example",
          role: "admin",
          emailVerified: true,
        },
      ]);
      await owner.insert(providerMembers).values({ userId: adminId, role: "administrator" });
      const [tenant] = await owner
        .insert(tenants)
        .values({
          providerId: provider?.id ?? "",
          name: "Contoso",
          slug: "contoso",
          language: "en",
          timeZone: "Europe/Berlin",
        })
        .returning();
      contoso = tenant?.id ?? "";
      const [hook] = await owner
        .insert(webhooks)
        .values({
          tenantId: contoso,
          url: "https://hooks.example/x",
          format: "discord",
          events: ["backup.failed", "notification.delivery_failed", "verify.red"],
        })
        .returning();
      hookId = hook?.id ?? "";
      await owner.insert(tenantNotificationRecipients).values([
        {
          tenantId: contoso,
          email: "ops@contoso.example",
          events: ["backup.failed", "verify.red", "notification.delivery_failed"],
          delivery: { error: "hourly" },
        },
        {
          tenantId: contoso,
          email: "gone@contoso.example",
          events: ["backup.failed", "notification.delivery_failed"],
        },
      ]);
      await owner.insert(reportRules).values({
        tenantId: contoso,
        name: "Errors",
        trigger: "event",
        events: ["backup.failed", "verify.red", "notification.delivery_failed"],
        throttleMinutes: 0,
        emailRecipients: ["ops@contoso.example", "gone@contoso.example", "adhoc@contoso.example"],
        webhookId: hookId,
      });
    }, 120_000);

    afterAll(async () => {
      const shared = await import("../../db.js");
      await Promise.all([
        shared.db.$client.end(),
        shared.providerDb.$client.end(),
        shared.authDb.$client.end(),
      ]);
      await appDb?.$client.end();
      await providerDb?.$client.end();
      await owner?.$client.end();
      await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
      await roles?.drop(testDatabaseAdminUrl as string);
    });

    beforeEach(async () => {
      notifier.sent.length = 0;
      notifier.answer = () => ({ ok: true });
      await owner.delete(reportDeliveries);
      await owner.delete(reportEvents);
      await owner.delete(notifications);
      await owner.update(settings).set({ mailFailure: null });
      await owner
        .update(tenantNotificationRecipients)
        .set({ failingSince: null, failureAlertedAt: null, lastFailureReason: null });
      await owner
        .update(providerNotificationRecipients)
        .set({ failingSince: null, failureAlertedAt: null, lastFailureReason: null });
      clock = new Date("2026-09-30T10:15:00.000Z");
    });

    async function raise(event: string, details: Record<string, unknown>, level = "error") {
      await mod.context.withTenantTx(appDb, contoso, (tx: never) =>
        raiseReportEvents(
          tx,
          [{ tenantId: contoso, level: level as "error", event, message: event, details }],
          clock,
        ),
      );
    }

    const rows = () => owner.select().from(reportDeliveries);

    describe("the provider's recipients", () => {
      it("keeps the owners as recipients of their own, which cannot be removed", async () => {
        const view = await mod.recipients.getProviderRecipients(providerDb, true);
        const owners = view.recipients.filter((row: { kind: string }) => row.kind === "owner");
        // The administrator is no owner; the one without a team row is.
        expect(owners.map((row: { email: string }) => row.email)).toEqual(["olivia@msp.example"]);
        expect(owners[0].lockedEvents).toContain("backup.suspicious");
        expect(owners[0].lockedEvents).toContain("notification.delivery_failed");
        await expect(
          mod.recipients.putProviderRecipients(
            providerDb,
            { recipients: [{ email: "noc@msp.example", events: ["backup.failed"] }] },
            { id: ownerId, email: "olivia@msp.example", ip: null, owner: true },
          ),
        ).rejects.toMatchObject({ status: 422, extensions: { code: "owner-required" } });
      });

      it("lets only an owner make a recipient mandatory", async () => {
        const view = await mod.recipients.getProviderRecipients(providerDb, true);
        const ownerRow = view.recipients.find((row: { kind: string }) => row.kind === "owner");
        const list = [
          { id: ownerRow.id, email: ownerRow.email, events: ownerRow.events },
          { email: "noc@msp.example", events: ["backup.failed"], mandatory: true },
        ];
        await expect(
          mod.recipients.putProviderRecipients(
            providerDb,
            { recipients: list },
            { id: adminId, email: "adam@msp.example", ip: null, owner: false },
          ),
        ).rejects.toMatchObject({ status: 403 });
        const saved = await mod.recipients.putProviderRecipients(
          providerDb,
          { recipients: [...list.slice(0, 1), { ...list[1], delivery: { warning: "daily" } }] },
          { id: ownerId, email: "olivia@msp.example", ip: null, owner: true },
        );
        const noc = saved.recipients.find(
          (row: { email: string }) => row.email === "noc@msp.example",
        );
        expect(noc).toMatchObject({ mandatory: true, kind: "member" });
        expect(noc.delivery).toEqual({ error: "immediate", warning: "daily", info: "immediate" });
        await expect(
          mod.recipients.putProviderRecipients(
            providerDb,
            {
              recipients: [
                ...list.slice(0, 1),
                { email: "noc@msp.example", events: [] },
                { email: "NOC@msp.example", events: [] },
              ],
            },
            { id: ownerId, email: "olivia@msp.example", ip: null, owner: true },
          ),
        ).rejects.toMatchObject({ status: 422 });
      });

      it("keeps an administrator from dropping or redirecting a mandatory recipient", async () => {
        const admin = { id: adminId, email: "adam@msp.example", ip: null, owner: false };
        const view = await mod.recipients.getProviderRecipients(providerDb, false);
        const ownerRow = view.recipients.find((row: { kind: string }) => row.kind === "owner");
        const noc = view.recipients.find(
          (row: { email: string }) => row.email === "noc@msp.example",
        );
        expect(noc).toMatchObject({ mandatory: true });
        const ownerEntry = { id: ownerRow.id, email: ownerRow.email, events: ownerRow.events };
        // Left out of the list.
        await expect(
          mod.recipients.putProviderRecipients(providerDb, { recipients: [ownerEntry] }, admin),
        ).rejects.toMatchObject({
          status: 403,
          type: "urn:restow:problem:owner-required",
          extensions: { email: "noc@msp.example" },
        });
        // Kept, mandatory untouched, but sent to another address.
        await expect(
          mod.recipients.putProviderRecipients(
            providerDb,
            {
              recipients: [
                ownerEntry,
                { id: noc.id, email: "attacker@elsewhere.example", events: noc.events },
              ],
            },
            admin,
          ),
        ).rejects.toMatchObject({ status: 403, type: "urn:restow:problem:owner-required" });
        const [stored] = await owner
          .select()
          .from(providerNotificationRecipients)
          .where(eq(providerNotificationRecipients.id, noc.id));
        expect(stored).toMatchObject({ email: "noc@msp.example", mandatory: true });
        // Saving the list with the mandatory recipient as it is stays allowed.
        const saved = await mod.recipients.putProviderRecipients(
          providerDb,
          {
            recipients: [
              ownerEntry,
              { id: noc.id, email: "NOC@msp.example", name: "NOC", events: noc.events },
            ],
          },
          admin,
        );
        expect(saved.recipients.find((row: { id: string }) => row.id === noc.id)).toMatchObject({
          email: "noc@msp.example",
          name: "NOC",
          mandatory: true,
        });
      });
    });

    describe("the fan-out", () => {
      it("reaches the floor with a critical event whatever its column, the column otherwise", async () => {
        await raise("verify.red", { protectedObjectId: randomUUID(), objectName: "Alice" });
        await mod.fanout.fanOutOnce(providerDb, clock);
        const provider = (await rows()).filter((row: ReportDelivery) => row.tenantId === null);
        // The owner (floor) and the mandatory recipient (floor) get it; nobody lists verify.red.
        expect(provider.map((row: ReportDelivery) => row.recipient).sort()).toEqual([
          "noc@msp.example",
          "olivia@msp.example",
        ]);
        expect(provider.every((row: ReportDelivery) => row.aboutTenantId === contoso)).toBe(true);
        expect(provider.every((row: ReportDelivery) => row.digest === null)).toBe(true);
        // backup.failed is in noc's column only.
        await raise("backup.failed", { protectedObjectId: randomUUID(), objectName: "Bob" });
        await mod.fanout.fanOutOnce(providerDb, clock);
        const failed = (await rows()).filter(
          (row: ReportDelivery) => row.tenantId === null && row.event === "backup.failed",
        );
        expect(failed.map((row: ReportDelivery) => row.recipient)).toEqual(["noc@msp.example"]);
      });

      it("throttles a subject for an hour and never mails an address twice for one event", async () => {
        const object = randomUUID();
        await raise("verify.red", { protectedObjectId: object });
        await raise("verify.red", { protectedObjectId: object });
        await mod.fanout.fanOutOnce(providerDb, clock);
        const owners = (await rows()).filter(
          (row: ReportDelivery) => row.recipient === "olivia@msp.example",
        );
        expect(owners).toHaveLength(1);
        // An address a tenant rule already mails for this event is skipped.
        await owner
          .update(providerNotificationRecipients)
          .set({ email: "adhoc@contoso.example" })
          .where(eq(providerNotificationRecipients.email, "noc@msp.example"));
        await raise("backup.failed", { protectedObjectId: randomUUID() });
        await mod.fanout.fanOutOnce(providerDb, clock);
        const adhoc = (await rows()).filter(
          (row: ReportDelivery) =>
            row.recipient === "adhoc@contoso.example" && row.event === "backup.failed",
        );
        expect(adhoc.map((row: ReportDelivery) => row.tenantId)).toEqual([contoso]);
        await owner
          .update(providerNotificationRecipients)
          .set({ email: "noc@msp.example" })
          .where(eq(providerNotificationRecipients.email, "adhoc@contoso.example"));
      });

      it("tells the provider of an installation event once, without a tenant", async () => {
        await providerDb.transaction((tx) =>
          mod.updates.raiseInstallationEvent(tx, {
            event: "update.available",
            level: "info",
            message: "update",
            details: { version: "0.5.1", objectName: "0.5.1" },
            now: clock,
          }),
        );
        await mod.fanout.fanOutOnce(providerDb, clock);
        const update = (await rows()).filter(
          (row: ReportDelivery) => row.event === "update.available",
        );
        expect(
          update.map((row: ReportDelivery) => [row.recipient, row.tenantId, row.aboutTenantId]),
        ).toEqual([["olivia@msp.example", null, null]]);
      });

      it("keeps every provider delivery out of the tenant's session", async () => {
        await raise("verify.red", { protectedObjectId: randomUUID() });
        await mod.fanout.fanOutOnce(providerDb, clock);
        expect((await rows()).some((row: ReportDelivery) => row.tenantId === null)).toBe(true);
        const seen = await mod.context.withTenantTx(appDb, contoso, (tx: Database) =>
          tx.select().from(reportDeliveries),
        );
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((row: ReportDelivery) => row.tenantId === contoso)).toBe(true);
        const events = await mod.context.withTenantTx(appDb, contoso, (tx: Database) =>
          tx.select().from(reportEvents),
        );
        expect(events.every((row: { tenantId: string | null }) => row.tenantId === contoso)).toBe(
          true,
        );
        // The provider's addresses are not even readable by the tenant role.
        await expect(
          mod.context.withTenantTx(appDb, contoso, (tx: Database) =>
            tx.select().from(providerNotificationRecipients),
          ),
        ).rejects.toThrow();
      });
    });

    describe("digests", () => {
      it("holds a recipient's errors until the next full hour and sends them in one mail", async () => {
        await raise("backup.failed", { protectedObjectId: randomUUID(), objectName: "Alice" });
        await raise("backup.failed", { protectedObjectId: randomUUID(), objectName: "Bob" });
        const held = (await rows()).filter(
          (row: ReportDelivery) => row.recipient === "ops@contoso.example",
        );
        expect(held).toHaveLength(2);
        expect(held.every((row: ReportDelivery) => row.digest === "hourly")).toBe(true);
        expect(held[0]?.nextAttemptAt.toISOString()).toBe("2026-09-30T11:00:00.000Z");
        // The others go at once.
        await mod.dispatcher.dispatchOnce(deps());
        expect(notifier.sent.map((m) => m.to)).not.toContain("ops@contoso.example");
        expect(notifier.sent.map((m) => m.to)).toContain("adhoc@contoso.example");
        notifier.sent.length = 0;
        expect(await mod.dispatcher.dispatchDigestsOnce(deps())).toBe(0);
        clock = new Date("2026-09-30T11:01:00.000Z");
        await mod.dispatcher.dispatchDigestsOnce(deps());
        expect(notifier.sent).toHaveLength(1);
        expect(notifier.sent[0]?.to).toBe("ops@contoso.example");
        expect(notifier.sent[0]?.subject).toContain("2 notifications");
        expect(notifier.sent[0]?.text).toContain("Alice");
        const sent = (await rows()).filter(
          (row: ReportDelivery) => row.recipient === "ops@contoso.example",
        );
        expect(sent.every((row: ReportDelivery) => row.status === "sent")).toBe(true);
        expect(new Set(sent.map((row: ReportDelivery) => row.digestGroup)).size).toBe(1);
      });

      it("sends critical events at once whatever the digest mode", async () => {
        await raise("verify.red", { protectedObjectId: randomUUID() });
        const ops = (await rows()).filter(
          (row: ReportDelivery) => row.recipient === "ops@contoso.example",
        );
        expect(ops.map((row: ReportDelivery) => row.digest)).toEqual([null]);
      });

      it("retries a digest that failed as one group", async () => {
        await raise("backup.failed", { protectedObjectId: randomUUID() });
        clock = new Date("2026-09-30T11:01:00.000Z");
        notifier.answer = () => ({ ok: false, reason: "transport_error", error: "421 try later" });
        await mod.dispatcher.dispatchDigestsOnce(deps());
        const [row] = (await rows()).filter(
          (r: ReportDelivery) => r.recipient === "ops@contoso.example",
        );
        expect(row?.status).toBe("pending");
        expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(clock.getTime());
      });
    });

    describe("delivery failures", () => {
      async function dispatchAll() {
        await mod.dispatcher.dispatchOnce(deps());
      }

      it("fails a refused address at once and tells the bell and the webhook, never that address", async () => {
        notifier.answer = (message) =>
          message.to === "gone@contoso.example"
            ? {
                ok: false,
                reason: "recipient_rejected",
                error: "550 5.1.1 user unknown",
                permanent: true,
              }
            : { ok: true };
        await raise("backup.failed", { protectedObjectId: randomUUID(), objectName: "Alice" });
        await dispatchAll();
        const [gone] = (await rows()).filter(
          (row: ReportDelivery) =>
            row.recipient === "gone@contoso.example" && row.event === "backup.failed",
        );
        expect(gone).toMatchObject({ status: "failed", attempts: 1 });
        const bell = await owner
          .select()
          .from(notifications)
          .where(eq(notifications.event, "notification.delivery_failed"));
        expect(bell).toHaveLength(1);
        expect(bell[0]).toMatchObject({ tenantId: contoso, level: "error" });
        expect(bell[0]?.details).toMatchObject({
          channel: "email",
          scope: "recipient",
          recipient: "gone@contoso.example",
          reason: "recipient_rejected",
          deliveryFailure: true,
        });
        const alerts = (await rows()).filter(
          (row: ReportDelivery) =>
            row.event === "notification.delivery_failed" && row.tenantId === contoso,
        );
        expect(alerts.map((row: ReportDelivery) => row.recipient)).not.toContain(
          "gone@contoso.example",
        );
        expect(
          alerts.some(
            (row: ReportDelivery) => row.channel === "webhook" && row.recipient === hookId,
          ),
        ).toBe(true);
        const [recipient] = await owner
          .select()
          .from(tenantNotificationRecipients)
          .where(eq(tenantNotificationRecipients.email, "gone@contoso.example"));
        expect(recipient?.failingSince).not.toBeNull();
        expect(recipient?.lastFailureReason).toBe("recipient_rejected");

        // The same episode alerts once; a delivered mail ends it.
        await raise("backup.failed", { protectedObjectId: randomUUID(), objectName: "Bob" });
        await dispatchAll();
        expect(
          await owner
            .select()
            .from(notifications)
            .where(eq(notifications.event, "notification.delivery_failed")),
        ).toHaveLength(1);
        notifier.answer = () => ({ ok: true });
        await raise("backup.failed", { protectedObjectId: randomUUID(), objectName: "Carol" });
        await dispatchAll();
        const [after] = await owner
          .select()
          .from(tenantNotificationRecipients)
          .where(eq(tenantNotificationRecipients.email, "gone@contoso.example"));
        expect(after?.failingSince).toBeNull();
      });

      it("raises one alert per episode while the transport is down, and a success ends it", async () => {
        notifier.answer = () => ({ ok: false, reason: "smtp_auth_failed", error: "535 auth" });
        await raise("backup.failed", { protectedObjectId: randomUUID() });
        // The last attempt: the rows fail now.
        await owner.update(reportDeliveries).set({ attempts: MAX_REPORT_ATTEMPTS - 1 });
        await dispatchAll();
        const [state] = await owner.select({ mailFailure: settings.mailFailure }).from(settings);
        expect(state?.mailFailure).toMatchObject({ reason: "smtp_auth_failed" });
        const installationBell = await owner
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.event, "notification.delivery_failed"),
              isNull(notifications.tenantId),
            ),
          );
        expect(installationBell).toHaveLength(1);
        expect(installationBell[0]?.details).toMatchObject({
          scope: "transport",
          channel: "email",
          audience: "installation",
        });
        // The alert concerns no tenant: it names none of the tenant's rules (members limited to
        // other tenants see the installation's bell).
        expect(installationBell[0]?.details).not.toHaveProperty("ruleId");
        expect(installationBell[0]?.details).not.toHaveProperty("ruleName");
        const [installationEvent] = await owner
          .select()
          .from(reportEvents)
          .where(
            and(
              eq(reportEvents.event, "notification.delivery_failed"),
              isNull(reportEvents.tenantId),
            ),
          );
        expect(installationEvent?.details).not.toHaveProperty("ruleName");
        // No e-mail is planned for the alert, the tenant's webhook is.
        const planned = (await rows()).filter(
          (row: ReportDelivery) =>
            row.event === "notification.delivery_failed" && row.status === "pending",
        );
        expect(
          planned.some(
            (row: ReportDelivery) =>
              row.channel === "webhook" && row.recipient === hookId && row.tenantId === contoso,
          ),
        ).toBe(true);
        expect(planned.every((row: ReportDelivery) => row.channel !== "email")).toBe(true);
        // More failures of the same episode: no new alert.
        await raise("backup.failed", { protectedObjectId: randomUUID() });
        await owner
          .update(reportDeliveries)
          .set({ attempts: MAX_REPORT_ATTEMPTS - 1 })
          .where(eq(reportDeliveries.status, "pending"));
        await dispatchAll();
        expect(
          await owner
            .select()
            .from(notifications)
            .where(
              and(
                eq(notifications.event, "notification.delivery_failed"),
                isNull(notifications.tenantId),
              ),
            ),
        ).toHaveLength(1);
        notifier.answer = () => ({ ok: true });
        await raise("backup.failed", { protectedObjectId: randomUUID() });
        await dispatchAll();
        const [cleared] = await owner.select({ mailFailure: settings.mailFailure }).from(settings);
        expect(cleared?.mailFailure).toBeNull();
      });

      it("keeps the transport's message out of what other tenants receive", async () => {
        const [provider] = await owner.select({ id: providers.id }).from(providers);
        const [fabrikam] = await owner
          .insert(tenants)
          .values({
            providerId: provider?.id ?? "",
            name: "Fabrikam",
            slug: `fabrikam-${randomUUID().slice(0, 8)}`,
            language: "en",
          })
          .returning();
        const fabrikamId = fabrikam?.id ?? "";
        const [fabrikamHook] = await owner
          .insert(webhooks)
          .values({
            tenantId: fabrikamId,
            url: "https://hooks.example/fabrikam",
            format: "restow",
            events: ["notification.delivery_failed"],
          })
          .returning();
        const [fabrikamRule] = await owner
          .insert(reportRules)
          .values({
            tenantId: fabrikamId,
            name: "Fabrikam alerts",
            trigger: "event",
            events: ["notification.delivery_failed"],
            throttleMinutes: 0,
            inApp: true,
            webhookId: fabrikamHook?.id ?? null,
          })
          .returning();
        try {
          // Contoso's branded From, refused by the relay: the reply names it and the login.
          notifier.answer = () => ({
            ok: false,
            reason: "smtp_sender_rejected",
            error:
              "Mail command failed: 553 5.7.1 <alerts@contoso-brand.example>: Sender address rejected: not owned by user msp-relay",
          });
          await raise("backup.failed", { protectedObjectId: randomUUID() });
          await owner.update(reportDeliveries).set({ attempts: MAX_REPORT_ATTEMPTS - 1 });
          await dispatchAll();
          // The alert's own deliveries (Fabrikam's webhook and bell) go out.
          notifier.answer = () => ({ ok: true });
          await dispatchAll();

          const fabrikamRows = await owner
            .select()
            .from(reportDeliveries)
            .where(eq(reportDeliveries.tenantId, fabrikamId));
          expect(fabrikamRows.map((row) => row.channel)).toContain("webhook");
          const seen = JSON.stringify([
            fabrikamRows,
            await owner
              .select()
              .from(webhookDeliveries)
              .where(eq(webhookDeliveries.tenantId, fabrikamId)),
            await owner.select().from(notifications).where(eq(notifications.tenantId, fabrikamId)),
            // The installation's bell, which members limited to other tenants read.
            await owner.select().from(notifications).where(isNull(notifications.tenantId)),
            await owner.select().from(reportEvents).where(isNull(reportEvents.tenantId)),
          ]);
          expect(seen).toContain("smtp_sender_rejected");
          for (const part of ["contoso-brand", "msp-relay", "Sender address rejected", "553"]) {
            expect(seen).not.toContain(part);
          }
          // The installation keeps the message for itself.
          const [state] = await owner.select({ mailFailure: settings.mailFailure }).from(settings);
          expect(state?.mailFailure?.detail).toContain("contoso-brand");
        } finally {
          await owner
            .update(reportRules)
            .set({ enabled: false })
            .where(eq(reportRules.id, fabrikamRule?.id ?? ""));
        }
      });

      describe("when raising the alert fails", () => {
        beforeEach(async () => {
          await owner.execute(sql`
            CREATE OR REPLACE FUNCTION probe_fail_installation_event() RETURNS trigger
              LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'probe: raise failed'; END $$`);
          await owner.execute(sql`
            CREATE TRIGGER probe_fail_installation_event BEFORE INSERT ON report_events
              FOR EACH ROW WHEN (NEW.tenant_id IS NULL)
              EXECUTE FUNCTION probe_fail_installation_event()`);
        });

        const dropTrigger = () =>
          owner.execute(sql`DROP TRIGGER IF EXISTS probe_fail_installation_event ON report_events`);

        afterEach(async () => {
          await dropTrigger();
          await owner.execute(sql`DROP FUNCTION IF EXISTS probe_fail_installation_event()`);
        });

        const installationAlerts = () =>
          owner
            .select()
            .from(notifications)
            .where(
              and(
                eq(notifications.event, "notification.delivery_failed"),
                isNull(notifications.tenantId),
              ),
            );

        it("claims no transport episode, so the next failure alerts", async () => {
          notifier.answer = () => ({
            ok: false,
            reason: "smtp_connection_failed",
            error: "connect ECONNREFUSED",
          });
          await raise("backup.failed", { protectedObjectId: randomUUID() });
          await owner.update(reportDeliveries).set({ attempts: MAX_REPORT_ATTEMPTS - 1 });
          await dispatchAll();
          expect(await installationAlerts()).toHaveLength(0);
          const [state] = await owner.select({ mailFailure: settings.mailFailure }).from(settings);
          expect(state?.mailFailure?.alertedAt ?? null).toBeNull();

          await dropTrigger();
          await raise("backup.failed", { protectedObjectId: randomUUID() });
          await owner
            .update(reportDeliveries)
            .set({ attempts: MAX_REPORT_ATTEMPTS - 1 })
            .where(eq(reportDeliveries.status, "pending"));
          await dispatchAll();
          const alerts = await installationAlerts();
          expect(alerts).toHaveLength(1);
          expect(alerts[0]?.details).toMatchObject({ scope: "transport" });
        });

        it("claims no provider recipient's episode, so the next failure alerts", async () => {
          notifier.answer = (message) =>
            message.to === "noc@msp.example"
              ? { ok: false, reason: "recipient_rejected", error: "550 gone", permanent: true }
              : { ok: true };
          await raise("backup.failed", { protectedObjectId: randomUUID() });
          await mod.fanout.fanOutOnce(providerDb, clock);
          await dispatchAll();
          expect(await installationAlerts()).toHaveLength(0);
          const noc = () =>
            owner
              .select()
              .from(providerNotificationRecipients)
              .where(eq(providerNotificationRecipients.email, "noc@msp.example"));
          expect((await noc())[0]?.failureAlertedAt ?? null).toBeNull();

          await dropTrigger();
          await raise("backup.failed", { protectedObjectId: randomUUID() });
          await mod.fanout.fanOutOnce(providerDb, clock);
          await dispatchAll();
          const alerts = await installationAlerts();
          expect(alerts).toHaveLength(1);
          expect(alerts[0]?.details).toMatchObject({
            audience: "provider",
            recipient: "noc@msp.example",
          });
          expect((await noc())[0]?.failureAlertedAt).not.toBeNull();
        });
      });

      it("stays quiet without a transport while the mail is marked not needed", async () => {
        await owner.update(settings).set({ mailNotNeeded: true });
        try {
          const quiet = { ...deps(), notifier: async () => null };
          await raise("verify.red", { protectedObjectId: randomUUID() });
          await mod.fanout.fanOutOnce(providerDb, clock);
          // No mail planned for the provider's recipients, owners included.
          expect((await rows()).filter((row: ReportDelivery) => row.tenantId === null)).toEqual([]);
          // The tenant's own rules fail as until 0.4, without an alert about the transport.
          await owner.update(reportDeliveries).set({ attempts: MAX_REPORT_ATTEMPTS - 1 });
          await mod.dispatcher.dispatchOnce(quiet);
          const failed = (await rows()).filter(
            (row: ReportDelivery) => row.channel === "email" && row.status === "failed",
          );
          expect(failed.length).toBeGreaterThan(0);
          const [state] = await owner.select({ mailFailure: settings.mailFailure }).from(settings);
          expect(state?.mailFailure).toBeNull();
          expect(
            await owner
              .select()
              .from(notifications)
              .where(
                and(
                  eq(notifications.event, "notification.delivery_failed"),
                  isNull(notifications.tenantId),
                ),
              ),
          ).toHaveLength(0);
          // The bell still has the event.
          expect(
            (await owner.select().from(notifications)).some(
              (row: { event: string }) => row.event === "verify.red",
            ),
          ).toBe(true);
        } finally {
          await owner.update(settings).set({ mailNotNeeded: false });
        }
      });

      it("never raises an alert about the alert's own failure", async () => {
        notifier.answer = () => ({
          ok: false,
          reason: "recipient_rejected",
          error: "550",
          permanent: true,
        });
        await raise("notification.delivery_failed", {
          channel: "webhook",
          scope: "webhook",
          webhookId: randomUUID(),
          reason: "http_error",
          deliveryFailure: true,
        });
        const before = (await owner.select().from(notifications)).length;
        await dispatchAll();
        expect((await owner.select().from(notifications)).length).toBe(before);
      });

      it("tells the installation's bell when a provider recipient's mail fails", async () => {
        notifier.answer = (message) =>
          message.to === "noc@msp.example"
            ? {
                ok: false,
                reason: "recipient_rejected",
                error: "550 no such user",
                permanent: true,
              }
            : { ok: true };
        await raise("backup.failed", { protectedObjectId: randomUUID() });
        await mod.fanout.fanOutOnce(providerDb, clock);
        await dispatchAll();
        const bell = await owner
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.event, "notification.delivery_failed"),
              isNull(notifications.tenantId),
            ),
          );
        expect(bell).toHaveLength(1);
        expect(bell[0]?.details).toMatchObject({
          audience: "provider",
          recipient: "noc@msp.example",
        });
        const [noc] = await owner
          .select()
          .from(providerNotificationRecipients)
          .where(eq(providerNotificationRecipients.email, "noc@msp.example"));
        expect(noc?.failingSince).not.toBeNull();
        // The provider's own failure reaches no tenant rule.
        const tenantAlerts = await owner
          .select()
          .from(reportDeliveries)
          .where(
            and(
              eq(reportDeliveries.event, "notification.delivery_failed"),
              sql`${reportDeliveries.tenantId} IS NOT NULL`,
            ),
          );
        expect(tenantAlerts).toHaveLength(0);
      });
    });
  },
);
