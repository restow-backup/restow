/**
 * Postgres-backed tests of alerts and reports, through the same Hono routes
 * the web UI calls and the dispatcher the API process runs: rule CRUD on the
 * application role that Row Level Security binds, tenant isolation, audit
 * entries, the Business gate for time-triggered reports, test sends, and the
 * outbox dispatcher (sent, retried while no mail transport is set up,
 * skipped for a report without the Business module, webhook hand-off) and the
 * bell.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_reports_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  notifications,
  providers,
  reportDeliveries,
  reportRules,
  tenants,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import { type Role, type TenantRole, roleSatisfies } from "../../middleware/rbac.js";
import type { TenantEnv } from "../../middleware/session.js";
import type { NotificationMessage, Notifier } from "../../notify.js";
import { ProblemError } from "../../problem.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { ReportDeliveryDto, ReportRuleDto } from "./service.js";

const DATABASE = "restow_api_reports_test";
const ROLE_HEADER = "x-test-role";

function testTenantAccess(minimum: TenantRole, userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const role = (c.req.header(ROLE_HEADER) ?? "tenant_admin") as Role;
    if (!roleSatisfies(role, minimum)) {
      throw new ProblemError(403, "Insufficient role");
    }
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", role);
    c.set("user", { id: userId, email: `${role}@contoso.example` } as unknown as SessionUser);
    await next();
  };
}

/** Admits a provider administrator (the `x-test-provider` header); no tenant is resolved. */
const testProviderAdmin: MiddlewareHandler = async (c, next) => {
  if (c.req.header("x-test-provider") !== "1") {
    throw new ProblemError(403, "Provider admin required");
  }
  await next();
};

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

describe.skipIf(!testDatabaseAdminUrl)("alerts and reports against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  const adminId = randomUUID();
  const clock = new Date("2026-09-30T10:00:00.000Z");

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);

    const { buildReportsRoutes, buildNotificationsRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const created = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso", language: "de" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";

    const deps = {
      db: appDb,
      providerDb,
      requireProviderAdmin: testProviderAdmin,
      requireReader: testTenantAccess("tenant_user", adminId),
      requireAdmin: testTenantAccess("tenant_admin", adminId),
      now: () => clock,
    };
    app = new Hono();
    app.onError(errorHandler);
    app.route("/reports", buildReportsRoutes(deps));
    app.route("/notifications", buildNotificationsRoutes(deps));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await providerDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  function call(
    method: string,
    path: string,
    options: { tenant?: string; role?: Role; body?: unknown } = {},
  ) {
    const headers: Record<string, string> = {
      "x-restow-tenant": options.tenant ?? contoso,
      [ROLE_HEADER]: options.role ?? "tenant_admin",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    return app.request(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  const ALERT = {
    trigger: "event",
    name: "Failed backups",
    events: ["backup.failed", "verify.red"],
    emailRecipients: ["IT@Contoso.example", "it@contoso.example"],
  };

  async function createAlert(tenant = contoso): Promise<ReportRuleDto> {
    const response = await call("POST", "/reports/rules", { body: ALERT, tenant });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ReportRuleDto;
  }

  it("creates an alert rule, deduplicates its recipients and audits it", async () => {
    const rule = await createAlert();
    expect(rule).toMatchObject({
      trigger: "event",
      events: ["backup.failed", "verify.red"],
      emailRecipients: ["it@contoso.example"],
      throttleMinutes: 60,
      locked: false,
      nextRunAt: null,
    });
    const entries = await owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "report.rule.created"), eq(auditLog.target, rule.id)));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.details).toMatchObject({ recipients: 1, trigger: "event" });
  });

  it("refuses an alert without events or channel, naming the field", async () => {
    const noEvents = await call("POST", "/reports/rules", { body: { ...ALERT, events: [] } });
    expect(noEvents.status).toBe(422);
    expect(await noEvents.json()).toMatchObject({ field: "events" });
    const noChannel = await call("POST", "/reports/rules", {
      body: { ...ALERT, emailRecipients: [] },
    });
    expect(noChannel.status).toBe(422);
    expect(await noChannel.json()).toMatchObject({ field: "channels" });
  });

  it("refuses time-triggered reports while no extension enables them", async () => {
    const response = await call("POST", "/reports/rules", {
      body: {
        trigger: "schedule",
        name: "Weekly",
        cron: "0 7 * * 1",
        timezone: "Europe/Berlin",
        sections: ["backups"],
        inApp: true,
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      type: "urn:restow:problem:feature-unavailable",
      feature: "reports.timed",
    });
    const catalog = await (await call("GET", "/reports/catalog")).json();
    expect(catalog).toMatchObject({ scheduledAvailable: false });
  });

  it("isolates tenants and keeps rules for administrators", async () => {
    const rule = await createAlert();
    const foreign = await call("PATCH", `/reports/rules/${rule.id}`, {
      tenant: fabrikam,
      body: { enabled: false },
    });
    expect(foreign.status).toBe(404);
    const list = (await (
      await call("GET", "/reports/rules", { tenant: fabrikam })
    ).json()) as unknown[];
    expect(list).toEqual([]);
    const asUser = await call("GET", "/reports/rules", { role: "tenant_user" });
    expect(asUser.status).toBe(403);
  });

  it("pauses, edits and deletes a rule; the log keeps its deliveries", async () => {
    const rule = await createAlert();
    const paused = await call("PATCH", `/reports/rules/${rule.id}`, { body: { enabled: false } });
    expect(await paused.json()).toMatchObject({ enabled: false });
    const edited = await call("PATCH", `/reports/rules/${rule.id}`, {
      body: { enabled: true, events: ["scrub.corrupt"], throttleMinutes: 0 },
    });
    expect(await edited.json()).toMatchObject({ events: ["scrub.corrupt"], throttleMinutes: 0 });
    const test = await call("POST", `/reports/rules/${rule.id}/test`);
    expect(test.status).toBe(202);
    expect(await test.json()).toEqual({ queued: 1 });
    const removed = await call("DELETE", `/reports/rules/${rule.id}`);
    expect(removed.status).toBe(204);
    const log = await owner
      .select()
      .from(reportDeliveries)
      .where(eq(reportDeliveries.ruleName, rule.name));
    expect(log.some((row) => row.ruleId === null)).toBe(true);
  });

  it("dispatches: sends mail in the tenant's language, retries without a mail transport", async () => {
    await owner.delete(reportDeliveries);
    const rule = await createAlert();
    await call("POST", `/reports/rules/${rule.id}/test`);
    const { dispatchOnce } = await import("./dispatcher.js");

    // No transport configured: the row stays pending with a reason, for a retry.
    const none = await dispatchOnce({
      providerDb,
      db: appDb,
      notifier: async () => null,
      now: () => clock,
    });
    expect(none).toBe(1);
    let [row] = await owner
      .select()
      .from(reportDeliveries)
      .where(eq(reportDeliveries.ruleId, rule.id));
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "mail_not_configured" });

    const notifier = new RecordingNotifier();
    const later = new Date(clock.getTime() + 2 * 60_000);
    await dispatchOnce({ providerDb, db: appDb, notifier: async () => notifier, now: () => later });
    [row] = await owner.select().from(reportDeliveries).where(eq(reportDeliveries.ruleId, rule.id));
    expect(row).toMatchObject({ status: "sent", attempts: 2 });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.to).toBe("it@contoso.example");
    // Contoso speaks German; the test is marked as such.
    expect(notifier.sent[0]?.subject).toBe(
      "[Contoso] Test: Sicherung fehlgeschlagen: test@example.com",
    );
    expect(notifier.sent[0]?.html).not.toContain("<script");

    const log = (await (await call("GET", "/reports/deliveries")).json()) as ReportDeliveryDto[];
    expect(log[0]).toMatchObject({
      status: "sent",
      channel: "email",
      recipient: "it@contoso.example",
    });
  });

  it("records e-mail as skipped in the public demo instead of pretending it was sent", async () => {
    await owner.delete(reportDeliveries);
    const rule = await createAlert();
    await call("POST", `/reports/rules/${rule.id}/test`);
    const { dispatchOnce } = await import("./dispatcher.js");
    const notifier = new RecordingNotifier();
    await dispatchOnce({
      providerDb,
      db: appDb,
      notifier: async () => notifier,
      demo: true,
      now: () => new Date(clock.getTime() + 5 * 60_000),
    });
    const [row] = await owner
      .select()
      .from(reportDeliveries)
      .where(eq(reportDeliveries.ruleId, rule.id));
    expect(row).toMatchObject({ status: "skipped", lastError: "demo_mode" });
    expect(notifier.sent).toEqual([]);
  });

  it("skips a summary report while no extension renders it", async () => {
    const [rule] = await owner
      .insert(reportRules)
      .values({
        tenantId: contoso,
        name: "Weekly",
        trigger: "schedule",
        cron: "0 7 * * 1",
        sections: ["backups"],
        inApp: true,
      })
      .returning();
    await owner.insert(reportDeliveries).values({
      tenantId: contoso,
      ruleId: rule?.id,
      ruleName: "Weekly",
      kind: "summary",
      payload: { periodDays: 7 },
      channel: "in_app",
      // Due at the test's clock, not the database's: the default now() is the
      // real time, which is later than the fixed clock below.
      nextAttemptAt: clock,
    });
    const { dispatchOnce } = await import("./dispatcher.js");
    await dispatchOnce({
      providerDb,
      db: appDb,
      notifier: async () => new RecordingNotifier(),
      now: () => new Date(clock.getTime() + 10 * 60_000),
    });
    const [row] = await owner
      .select()
      .from(reportDeliveries)
      .where(eq(reportDeliveries.ruleId, rule?.id ?? ""));
    expect(row).toMatchObject({ status: "skipped", lastError: "not_available" });
    const listed = (await (await call("GET", "/reports/rules")).json()) as ReportRuleDto[];
    expect(listed.find((item) => item.id === rule?.id)).toMatchObject({ locked: true });
  });

  it("hands a webhook channel to the webhook outbox", async () => {
    const [hook] = await owner
      .insert(webhooks)
      .values({ tenantId: contoso, url: "https://rmm.example/hook", events: [] })
      .returning();
    const response = await call("POST", "/reports/rules", {
      body: { ...ALERT, name: "To RMM", emailRecipients: [], webhookId: hook?.id },
    });
    const rule = (await response.json()) as ReportRuleDto;
    await call("POST", `/reports/rules/${rule.id}/test`);
    const { dispatchOnce } = await import("./dispatcher.js");
    await dispatchOnce({
      providerDb,
      db: appDb,
      notifier: async () => null,
      now: () => new Date(clock.getTime() + 20 * 60_000),
    });
    const handed = await owner
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook?.id ?? ""));
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ event: "report.alert", status: "pending" });
    expect(handed[0]?.payload).toMatchObject({
      event: "report.alert",
      data: { rule: { id: rule.id } },
    });
  });

  it("lists the bell per tenant and marks entries read", async () => {
    await owner.insert(notifications).values([
      { tenantId: contoso, level: "error", event: "backup.failed", message: "Backup failed" },
      { tenantId: contoso, level: "info", event: "verify.recovered", message: "Green again" },
      { tenantId: fabrikam, level: "error", event: "backup.failed", message: "Other tenant" },
    ]);
    const bell = (await (await call("GET", "/notifications", { role: "tenant_user" })).json()) as {
      unread: number;
      unreadAttention: number;
      items: { message: string }[];
    };
    expect(bell.unread).toBe(2);
    // One failure and one "green again": only the failure needs attention.
    expect(bell.unreadAttention).toBe(1);
    expect(bell.items.map((item) => item.message)).not.toContain("Other tenant");
    const marked = await call("POST", "/notifications/read", {
      role: "tenant_user",
      body: { all: true },
    });
    expect(await marked.json()).toEqual({ updated: 2 });
    const read = (await (await call("GET", "/notifications", { role: "tenant_user" })).json()) as {
      unread: number;
      unreadAttention: number;
    };
    expect(read).toMatchObject({ unread: 0, unreadAttention: 0 });
    const foreign = (await (await call("GET", "/notifications", { tenant: fabrikam })).json()) as {
      unread: number;
      unreadAttention: number;
    };
    expect(foreign).toMatchObject({ unread: 1, unreadAttention: 1 });
  });

  it("gives a provider administrator without a tenant the installation-level notifications alone", async () => {
    await owner.delete(notifications).where(isNull(notifications.tenantId));
    await owner.insert(notifications).values([
      {
        tenantId: null,
        level: "info",
        event: "update.available",
        message: "Version 0.2.0 is available",
        details: { version: "0.2.0" },
      },
      { tenantId: null, level: "error", event: "update.failed", message: "The update failed" },
      { tenantId: contoso, level: "error", event: "backup.failed", message: "Contoso only" },
    ]);
    const asProvider = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        // No tenant header: there is no tenant to name.
        headers: {
          "x-test-provider": "1",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const bell = (await (await asProvider("GET", "/notifications/installation")).json()) as {
      unread: number;
      unreadAttention: number;
      items: { message: string; tenantId: string | null }[];
    };
    expect(bell.unread).toBe(2);
    // "An update is available" is information; "the update failed" needs attention.
    expect(bell.unreadAttention).toBe(1);
    expect(bell.items.map((item) => item.message).sort()).toEqual([
      "The update failed",
      "Version 0.2.0 is available",
    ]);
    expect(bell.items.every((item) => item.tenantId === null)).toBe(true);

    // Marking one read touches that entry and nothing of any tenant.
    const first = bell.items.find((item) => item.message === "The update failed") as unknown as {
      id: string;
    };
    const one = await asProvider("POST", "/notifications/installation/read", { ids: [first.id] });
    expect(await one.json()).toEqual({ updated: 1 });
    const after = (await (await asProvider("GET", "/notifications/installation")).json()) as {
      unread: number;
      unreadAttention: number;
    };
    expect(after.unread).toBe(1);
    // What is left unread is the information that an update is available.
    expect(after.unreadAttention).toBe(0);
    const all = await asProvider("POST", "/notifications/installation/read", { all: true });
    expect(await all.json()).toEqual({ updated: 1 });
    const tenantRows = await owner
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, contoso), eq(notifications.message, "Contoso only")));
    expect(tenantRows[0]?.readAt).toBeNull();
  });

  it("keeps the installation-level notifications from everyone who is not a provider administrator", async () => {
    for (const [method, path] of [
      ["GET", "/notifications/installation"],
      ["POST", "/notifications/installation/read"],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { "x-restow-tenant": contoso, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ all: true }) : undefined,
      });
      expect(response.status, path).toBe(403);
    }
    // A tenant's own bell never lists them.
    const own = (await (await call("GET", "/notifications", { role: "tenant_admin" })).json()) as {
      items: { tenantId: string | null }[];
    };
    expect(own.items.some((item) => item.tenantId === null)).toBe(false);
  });
});
