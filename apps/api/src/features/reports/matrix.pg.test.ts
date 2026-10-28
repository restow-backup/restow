/**
 * The notification matrix against Postgres, through the routes the web UI calls, on the
 * application role that Row Level Security binds:
 *
 *   - the matrix lists the catalog's events and every channel of the tenant (the bell, each
 *     webhook, each notification recipient) with the events it gets; installation events are
 *     rows for provider administrators only, and a tenant administrator's save keeps them;
 *   - unticking "Backup succeeded" for a Discord webhook stops the stream's job.completed for
 *     backups while failures still arrive, and a rule's alert to it is skipped once its column has
 *     the event off;
 *   - a recipient's column brings the recipients' rules along, the bell's column hides what it has
 *     off, and every save is audited without an address.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_matrix_test` is recreated there and dropped after, the roles with it).
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  auditLog,
  createDb,
  type Database,
  notifications,
  providers,
  reportDeliveries,
  reportRules,
  tenantNotificationRecipients,
  tenants,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import type { TenantEnv } from "../../middleware/session.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { NotificationMatrixDto } from "./matrix.js";

const DATABASE = "restow_api_matrix_test";

/** A tenant administrator, or a provider administrator with `x-test-provider: 1`. */
function testAccess(userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", "tenant_admin");
    c.set("isProviderAdmin", c.req.header("x-test-provider") === "1");
    c.set("user", { id: userId, email: "admin@contoso.example" } as unknown as SessionUser);
    await next();
  };
}

describe.skipIf(!testDatabaseAdminUrl)("the notification matrix against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let tenantId = "";
  let discord = "";
  let signed = "";
  let recipient = "";
  const adminId = randomUUID();
  const clock = new Date("2026-10-15T10:00:00.000Z");

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
    const { newWebhookEvents } = await import("../webhooks/service.js");

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id ?? "";
    const hooks = await owner
      .insert(webhooks)
      .values([
        {
          tenantId,
          name: "Ops channel",
          url: "https://discord.example/api/webhooks/1/token",
          format: "discord",
          // An existing chat webhook that subscribed to everything before the matrix.
          events: newWebhookEvents("restow", ["job.failed", "job.completed"]),
          createdAt: new Date("2026-10-01T08:00:00.000Z"),
        },
        {
          tenantId,
          name: "PSA",
          url: "https://psa.example/hooks/restow",
          format: "restow",
          events: newWebhookEvents("restow"),
          createdAt: new Date("2026-10-02T08:00:00.000Z"),
        },
      ])
      .returning();
    discord = hooks[0]?.id ?? "";
    signed = hooks[1]?.id ?? "";
    const [row] = await owner
      .insert(tenantNotificationRecipients)
      .values({
        tenantId,
        email: "Ops@contoso.example",
        events: ["backup.failed", "report.weekly"],
      })
      .returning();
    recipient = row?.id ?? "";

    const deps = {
      db: appDb,
      providerDb,
      requireReader: testAccess(adminId),
      requireAdmin: testAccess(adminId),
      now: () => clock,
    };
    app = new Hono();
    app.onError(errorHandler);
    app.route("/reports", buildReportsRoutes(deps));
    app.route("/notifications", buildNotificationsRoutes(deps));
  }, 60_000);

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

  const call = (
    method: string,
    path: string,
    options: { body?: unknown; provider?: boolean } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-restow-tenant": tenantId,
        ...(options.provider ? { "x-test-provider": "1" } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  const matrix = async (provider = false) =>
    (await (await call("GET", "/reports/matrix", { provider })).json()) as NotificationMatrixDto;

  const columnOf = (dto: NotificationMatrixDto, id: string) =>
    dto.channels.find((channel) => channel.id === id)?.events ?? [];

  it("lists every event and every channel with what it gets", async () => {
    const dto = await matrix();
    expect(dto.events.map((event) => event.name)).toContain("backup.succeeded");
    // An update is the provider's business.
    expect(dto.events.map((event) => event.name)).not.toContain("update.available");
    expect(dto.events.find((event) => event.name === "backup.succeeded")).toEqual({
      name: "backup.succeeded",
      group: "jobs",
      level: "info",
    });
    expect(dto.channels.map((channel) => [channel.kind, channel.id])).toEqual([
      ["bell", "bell"],
      ["webhook", discord],
      ["webhook", signed],
      ["email", recipient],
    ]);
    const bell = dto.channels[0];
    expect(bell).toMatchObject({ custom: false });
    expect(bell?.events).toContain("backup.failed");
    expect(bell?.events).not.toContain("backup.succeeded");
    expect(columnOf(dto, discord)).toContain("backup.succeeded");
    expect(dto.channels[1]).toMatchObject({ host: "discord.example", format: "discord" });
    expect(dto.channels[3]).toMatchObject({
      email: "Ops@contoso.example",
      events: ["backup.failed"],
      weeklyReport: true,
    });
    expect((await matrix(true)).events.map((event) => event.name)).toContain("update.available");
  });

  it("shows the source's app expiry to tenant administrators, the central app's only to providers", async () => {
    const tenantView = (await matrix()).events;
    expect(tenantView.find((event) => event.name === "source.app_secret_expiring")).toEqual({
      name: "source.app_secret_expiring",
      group: "jobs",
      level: "warning",
    });
    expect(tenantView.map((event) => event.name)).not.toContain("installation.app_secret_expiring");
    const providerView = (await matrix(true)).events;
    expect(providerView.find((event) => event.name === "installation.app_secret_expiring")).toEqual(
      { name: "installation.app_secret_expiring", group: "system", level: "warning" },
    );
  });

  it("stops the posts of successful backups to Discord while failures still arrive", async () => {
    const { emitWebhookEvent } = await import("../../lib/webhooks.js");
    const reached = async (event: "job.completed" | "job.failed", queue: string) => {
      const emitted = await emitWebhookEvent(appDb, {
        tenantId,
        event,
        data: { job: { queue, status: event === "job.failed" ? "failed" : "completed" } },
      });
      if (emitted.deliveryIds.length === 0) {
        return false;
      }
      const rows = await owner
        .select({ webhookId: webhookDeliveries.webhookId })
        .from(webhookDeliveries)
        .where(inArray(webhookDeliveries.id, emitted.deliveryIds));
      return rows.some((row) => row.webhookId === discord);
    };
    expect(await reached("job.completed", "backup")).toBe(true);

    const without = columnOf(await matrix(), discord).filter(
      (event) => event !== "backup.succeeded",
    );
    const saved = await call("PUT", "/reports/matrix", {
      body: { channels: [{ kind: "webhook", id: discord, events: without }] },
    });
    expect(saved.status).toBe(200);
    expect(columnOf((await saved.json()) as NotificationMatrixDto, discord)).not.toContain(
      "backup.succeeded",
    );

    expect(await reached("job.completed", "backup")).toBe(false);
    expect(await reached("job.failed", "backup")).toBe(true);
    // A finished restore is its own row, still on.
    expect(await reached("job.completed", "restore")).toBe(true);
    // The signed webhook was not touched and still gets every success.
    const [psa] = await owner.select().from(webhooks).where(eq(webhooks.id, signed));
    expect(psa?.events).toContain("job.completed");
    expect(psa?.events).toContain("backup.succeeded");
  });

  it("skips a queued rule alert to a channel whose column switched the event off", async () => {
    const { dispatchOnce } = await import("./dispatcher.js");
    const [rule] = await owner
      .insert(reportRules)
      .values({
        tenantId,
        name: "Successes",
        trigger: "event",
        events: ["backup.succeeded"],
        webhookId: discord,
      })
      .returning();
    const [queued] = await owner
      .insert(reportDeliveries)
      .values({
        tenantId,
        ruleId: rule?.id ?? null,
        ruleName: "Successes",
        kind: "event",
        event: "backup.succeeded",
        subjectKey: "object:m1",
        payload: { event: "backup.succeeded", level: "info", message: "ok", details: {} },
        channel: "webhook",
        recipient: discord,
        status: "pending",
        nextAttemptAt: clock,
      })
      .returning();
    await dispatchOnce({ providerDb, db: appDb, notifier: async () => null, now: () => clock });
    const [row] = await owner
      .select()
      .from(reportDeliveries)
      .where(eq(reportDeliveries.id, queued?.id ?? ""));
    expect(row).toMatchObject({ status: "skipped", lastError: "channel_off" });
  });

  it("brings the recipients' rules along with a recipient's column, and keeps the weekly report", async () => {
    const saved = await call("PUT", "/reports/matrix", {
      body: {
        channels: [
          { kind: "email", id: recipient, events: ["backup.failed", "backup.overdue", "nonsense"] },
        ],
      },
    });
    // Unknown events are refused.
    expect(saved.status).toBe(422);
    const ok = await call("PUT", "/reports/matrix", {
      body: {
        channels: [{ kind: "email", id: recipient, events: ["backup.failed", "backup.overdue"] }],
      },
    });
    expect(ok.status).toBe(200);
    const [stored] = await owner
      .select()
      .from(tenantNotificationRecipients)
      .where(eq(tenantNotificationRecipients.id, recipient));
    expect(stored?.events).toEqual(["backup.failed", "backup.overdue", "report.weekly"]);
    const rules = await owner
      .select()
      .from(reportRules)
      .where(and(eq(reportRules.tenantId, tenantId)));
    const warnings = rules.find((rule) => rule.recipientCategory === "warnings");
    expect(warnings).toMatchObject({
      events: ["backup.overdue"],
      emailRecipients: ["ops@contoso.example"],
    });
    expect(rules.find((rule) => rule.recipientCategory === "jobFailures")?.emailRecipients).toEqual(
      ["ops@contoso.example"],
    );
    const entry = (await owner.select().from(auditLog).where(eq(auditLog.tenantId, tenantId))).find(
      (candidate) => candidate.action === "report.matrix_updated",
    );
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry?.details)).not.toContain("ops@contoso.example");
  });

  it("keeps the installation events when a tenant administrator saves a column", async () => {
    const before = columnOf(await matrix(true), signed);
    expect(before).toContain("update.available");
    await call("PUT", "/reports/matrix", {
      body: { channels: [{ kind: "webhook", id: signed, events: ["backup.failed"] }] },
    });
    const [psa] = await owner.select().from(webhooks).where(eq(webhooks.id, signed));
    expect(psa?.events).toContain("update.available");
    expect(psa?.events).toContain("backup.failed");
    expect(psa?.events).not.toContain("verify.red");
    // The provider administrator may switch it off.
    await call("PUT", "/reports/matrix", {
      provider: true,
      body: { channels: [{ kind: "webhook", id: signed, events: ["backup.failed"] }] },
    });
    const [after] = await owner.select().from(webhooks).where(eq(webhooks.id, signed));
    expect(after?.events).not.toContain("update.available");
  });

  it("hides from the bell what its column has off, and shows it again when switched on", async () => {
    await owner.insert(notifications).values([
      { tenantId, level: "error", event: "verify.red", message: "red" },
      { tenantId, level: "error", event: "backup.failed", message: "failed" },
      { tenantId, level: "info", event: "report.ready", message: "report" },
    ]);
    const bell = async () =>
      (await (await call("GET", "/notifications")).json()) as {
        items: { event: string }[];
        unread: number;
      };
    expect((await bell()).items.map((item) => item.event).sort()).toEqual([
      "backup.failed",
      "report.ready",
      "verify.red",
    ]);
    await call("PUT", "/reports/matrix", {
      body: { channels: [{ kind: "bell", events: ["backup.failed"] }] },
    });
    const filtered = await bell();
    expect(filtered.items.map((item) => item.event).sort()).toEqual([
      "backup.failed",
      "report.ready",
    ]);
    expect(filtered.unread).toBe(2);
    const history = (await (await call("GET", "/notifications/history")).json()) as {
      items: { event: string }[];
    };
    expect(history.items.map((item) => item.event)).not.toContain("verify.red");
    expect((await matrix()).channels[0]).toMatchObject({ custom: true, events: ["backup.failed"] });
  });
});
