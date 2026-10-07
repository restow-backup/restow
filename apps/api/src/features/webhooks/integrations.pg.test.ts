/**
 * Postgres-backed tests of the integration surface: API keys (creation with a
 * one-time token, authentication by hash, scopes, rate-limit headers,
 * revocation, expiry, provider keys and their feature gate) and webhooks
 * (sealed signing secrets, fan-out of emitted events, the delivery log with
 * cursor paging, redelivery, pausing, rotation, deletion), all through the
 * same Hono surface the web UI and integrations use.
 *
 * The API's own pools run on the provisioned database roles, as in
 * production: the application role that Row Level Security binds and the
 * installation role for the key lookup (src/testing/database-roles.ts). The
 * suite's own handle is the owner, for fixtures and assertions.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_integrations_test` is recreated there
 * and dropped after, the roles with it). Without it the suite is skipped;
 * docs/TESTING.md lists it under integration.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  apiKeys,
  auditLog,
  createDb,
  providers,
  secrets,
  tenants,
  user,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../../extensions.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_integrations_test";

type ApiKeysService = typeof import("../apikeys/service.js");
type Middleware = typeof import("../../middleware/apiKey.js");
type WebhooksService = typeof import("./service.js");
type WebhooksLib = typeof import("../../lib/webhooks.js");
type Secrets = typeof import("../../lib/secrets.js");

interface CreatedHook {
  id: string;
  secret: string;
  events: string[];
}

describe.skipIf(!testDatabaseAdminUrl)("API keys and webhooks against Postgres", () => {
  let db: Database;
  let roles: TestDatabaseRoles | undefined;
  /** Whether the test gate opens provider keys (`apiKeys.provider`, lib/features.ts). */
  let providerKeys = true;
  let keys: ApiKeysService;
  let middleware: Middleware;
  let hooks: WebhooksService;
  let lib: WebhooksLib;
  let secretStore: Secrets;
  let app: Hono;
  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;

  const actor = () => ({ userId: adminId, label: "admin@contoso.example", ip: "192.0.2.10" });

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles and configuration read the environment on import.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    registerApiExtension({
      name: "test-gate",
      featureGate: {
        isEnabled: async (_db, feature) => feature === "apiKeys.provider" && providerKeys,
      },
    });

    db = createDb(url);
    keys = await import("../apikeys/service.js");
    middleware = await import("../../middleware/apiKey.js");
    hooks = await import("./service.js");
    lib = await import("../../lib/webhooks.js");
    secretStore = await import("../../lib/secrets.js");
    const { webhooksRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");

    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant, other] = await db
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso-gmbh" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    tenantId = tenant?.id ?? "";
    otherTenantId = other?.id ?? "";
    for (const id of [tenantId, otherTenantId]) {
      await db.transaction((tx) => secretStore.createTenantKey(tx, id));
    }
    adminId = randomUUID();
    await db.insert(user).values({
      id: adminId,
      name: "Admin",
      email: "admin@contoso.example",
      emailVerified: true,
    });

    app = new Hono();
    app.onError(errorHandler);
    app.get("/probe", middleware.requireApiKey("status:read"), (c) => c.json(c.get("apiKey")));
    app.get("/provider-only", middleware.requireApiKey("status:read", { provider: true }), (c) =>
      c.json({ ok: true }),
    );
    app.route("/webhooks", webhooksRoutes);
  }, 60_000);

  afterAll(async () => {
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  const bearer = (token: string, extra: Record<string, string> = {}) => ({
    headers: { authorization: `Bearer ${token}`, ...extra },
  });

  async function newKey(scopes: string[], expiresInDays: number | null = null) {
    return keys.createKey(
      db,
      { kind: "tenant", tenantId },
      { name: "RMM", scopes: scopes as never, expiresInDays },
      actor(),
    );
  }

  describe("API keys", () => {
    it("returns the token once and stores only its hash and prefix", async () => {
      const created = await newKey(["status:read", "jobs:read"]);
      expect(created.token).toMatch(/^rsk_contosogmbh_[0-9A-Za-z]{40}$/);
      expect(created.prefix).toBe(created.token.slice(0, "rsk_contosogmbh_".length + 8));
      expect(created).toMatchObject({
        kind: "tenant",
        tenantId,
        status: "active",
        scopes: ["status:read", "jobs:read"],
        createdBy: { id: adminId, email: "admin@contoso.example" },
      });

      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
      expect(JSON.stringify(row)).not.toContain(created.token);
      const listed = await keys.listKeys(db, { kind: "tenant", tenantId });
      expect(listed.map((key) => key.id)).toContain(created.id);
      expect(JSON.stringify(listed)).not.toContain(created.token);

      const [entry] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "api_key.created"), eq(auditLog.target, created.id)));
      expect(entry?.tenantId).toBe(tenantId);
      expect(JSON.stringify(entry)).not.toContain(created.token);
    });

    it("authenticates by hash, checks scopes and reports the rate limit", async () => {
      const created = await newKey(["status:read"]);
      const ok = await app.request("/probe", bearer(created.token));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        keyId: created.id,
        tenantId,
        isProvider: false,
        scopes: ["status:read"],
      });
      expect(ok.headers.get("RateLimit-Limit")).toBe("600");
      expect(Number(ok.headers.get("RateLimit-Remaining"))).toBe(599);

      const limited = await newKey(["jobs:read"]);
      const forbidden = await app.request("/probe", bearer(limited.token));
      expect(forbidden.status).toBe(403);
      expect(((await forbidden.json()) as { requiredScope: string }).requiredScope).toBe(
        "status:read",
      );

      const provider = await app.request("/provider-only", bearer(created.token));
      expect(provider.status).toBe(403);

      const tampered = `${created.token.slice(0, -1)}${created.token.endsWith("a") ? "b" : "a"}`;
      expect((await app.request("/probe", bearer(tampered))).status).toBe(401);
    });

    it("records when a key was last used", async () => {
      const created = await newKey(["status:read"]);
      expect(created.lastUsedAt).toBeNull();
      await app.request("/probe", bearer(created.token));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
      expect(row?.lastUsedAt).toBeInstanceOf(Date);
    });

    it("refuses requests beyond 600 per 10 minutes with 429 and Retry-After", async () => {
      const created = await newKey(["status:read"]);
      const now = Date.now();
      for (let i = 0; i < 600; i++) {
        middleware.apiKeyRateLimiter.consume(created.id, now);
      }
      const response = await app.request("/probe", bearer(created.token));
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(response.headers.get("RateLimit-Remaining")).toBe("0");
    });

    it("stops a revoked key at once and keeps the row", async () => {
      const created = await newKey(["status:read"]);
      const revoked = await keys.revokeKey(db, { kind: "tenant", tenantId }, created.id, actor());
      expect(revoked.status).toBe("revoked");
      const response = await app.request("/probe", bearer(created.token));
      expect(response.status).toBe(401);
      expect(((await response.json()) as { detail: string }).detail).toContain("revoked");
      // Idempotent, audited once.
      await keys.revokeKey(db, { kind: "tenant", tenantId }, created.id, actor());
      const entries = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "api_key.revoked"), eq(auditLog.target, created.id)));
      expect(entries).toHaveLength(1);
    });

    it("stops an expired key", async () => {
      const created = await newKey(["status:read"], 1);
      await db
        .update(apiKeys)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(apiKeys.id, created.id));
      const response = await app.request("/probe", bearer(created.token));
      expect(response.status).toBe(401);
      expect(((await response.json()) as { detail: string }).detail).toContain("expired");
      const [listed] = (await keys.listKeys(db, { kind: "tenant", tenantId })).filter(
        (key) => key.id === created.id,
      );
      expect(listed?.status).toBe("expired");
    });

    it("keeps tenants apart", async () => {
      const created = await newKey(["status:read"]);
      await expect(
        keys.revokeKey(db, { kind: "tenant", tenantId: otherTenantId }, created.id, actor()),
      ).rejects.toMatchObject({ status: 404 });
      const theirs = await keys.listKeys(db, { kind: "tenant", tenantId: otherTenantId });
      expect(theirs).toHaveLength(0);
    });

    it("refuses keys of a suspended tenant", async () => {
      const created = await keys.createKey(
        db,
        { kind: "tenant", tenantId: otherTenantId },
        { name: "Suspended", scopes: ["status:read"], expiresInDays: null },
        actor(),
      );
      await db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, otherTenantId));
      expect((await app.request("/probe", bearer(created.token))).status).toBe(403);
      await db.update(tenants).set({ status: "active" }).where(eq(tenants.id, otherTenantId));
      expect((await app.request("/probe", bearer(created.token))).status).toBe(200);
    });

    it("issues provider keys that name the tenant per request", async () => {
      const created = await keys.createKey(
        db,
        { kind: "provider" },
        { name: "RMM", scopes: ["status:read", "webhooks:manage"], expiresInDays: null },
        actor(),
      );
      expect(created.token).toMatch(/^rsk_provider_/);
      expect(created.kind).toBe("provider");
      expect((await app.request("/provider-only", bearer(created.token))).status).toBe(200);

      const withoutTenant = await app.request("/webhooks", bearer(created.token));
      expect(withoutTenant.status).toBe(400);
      const withTenant = await app.request(
        "/webhooks",
        bearer(created.token, { "x-restow-tenant": otherTenantId }),
      );
      expect(withTenant.status).toBe(200);
      const unknown = await app.request(
        "/webhooks",
        bearer(created.token, { "x-restow-tenant": randomUUID() }),
      );
      expect(unknown.status).toBe(404);

      const listed = await keys.listProviderKeys(db);
      expect(listed.available).toBe(true);
      expect(listed.items.map((key) => key.id)).toEqual([created.id]);
      // Tenant lists never show provider keys.
      const tenantList = await keys.listKeys(db, { kind: "tenant", tenantId });
      expect(tenantList.some((key) => key.id === created.id)).toBe(false);
    });

    it("retires provider keys on the feature routes once they are switched off", async () => {
      const created = await keys.createKey(
        db,
        { kind: "provider" },
        { name: "RMM", scopes: ["webhooks:manage"], expiresInDays: null },
        actor(),
      );
      const named = bearer(created.token, { "x-restow-tenant": tenantId });
      expect((await app.request("/webhooks/events", named)).status).toBe(200);

      providerKeys = false;
      try {
        for (const path of ["/webhooks", "/webhooks/events"]) {
          const refused = await app.request(path, named);
          expect(refused.status).toBe(403);
          expect(await refused.json()).toMatchObject({
            type: "urn:restow:problem:feature-unavailable",
          });
        }
      } finally {
        providerKeys = true;
      }
    });

    it("lets a provider key read a suspended tenant's webhooks but change nothing", async () => {
      const created = await keys.createKey(
        db,
        { kind: "provider" },
        { name: "RMM", scopes: ["webhooks:manage"], expiresInDays: null },
        actor(),
      );
      const named = bearer(created.token, { "x-restow-tenant": otherTenantId });
      await db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, otherTenantId));
      try {
        expect((await app.request("/webhooks", named)).status).toBe(200);
        const change = await app.request("/webhooks", {
          method: "POST",
          headers: { ...named.headers, "content-type": "application/json" },
          body: JSON.stringify({ url: "https://psa.example/hook", events: ["job.failed"] }),
        });
        expect(change.status).toBe(409);
        expect(await change.json()).toMatchObject({
          type: "urn:restow:problem:tenant-not-active",
        });
      } finally {
        await db.update(tenants).set({ status: "active" }).where(eq(tenants.id, otherTenantId));
      }
    });

    it("refuses new provider keys while they are switched off", async () => {
      providerKeys = false;
      try {
        await expect(
          keys.createKey(
            db,
            { kind: "provider" },
            { name: "RMM", scopes: ["status:read"], expiresInDays: null },
            actor(),
          ),
        ).rejects.toMatchObject({ status: 403, type: "urn:restow:problem:feature-unavailable" });
        expect((await keys.listProviderKeys(db)).available).toBe(false);
      } finally {
        providerKeys = true;
      }
    });
  });

  describe("webhooks", () => {
    let manager: string;

    beforeAll(async () => {
      manager = (await newKey(["webhooks:manage"])).token;
    });

    async function createHook(body: Record<string, unknown>): Promise<CreatedHook> {
      const response = await app.request("/webhooks", {
        method: "POST",
        headers: { authorization: `Bearer ${manager}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return (await response.json()) as CreatedHook;
    }

    it("needs the webhooks:manage scope and stays inside the key's tenant", async () => {
      const reader = await newKey(["status:read"]);
      expect((await app.request("/webhooks", bearer(reader.token))).status).toBe(403);
      const foreign = await app.request(
        "/webhooks",
        bearer(manager, { "x-restow-tenant": otherTenantId }),
      );
      expect(foreign.status).toBe(403);
    });

    it("creates a webhook with a sealed signing secret shown once", async () => {
      const created = await createHook({
        url: "https://dash.example.com/hooks/restow",
        events: ["job.failed"],
      });
      expect(created.secret).toMatch(/^whsec_/);
      const [row] = await db.select().from(webhooks).where(eq(webhooks.id, created.id));
      expect(row?.secretRef).not.toBeNull();
      const [sealed] = await db
        .select()
        .from(secrets)
        .where(eq(secrets.id, row?.secretRef ?? ""));
      expect(sealed?.kind).toBe("webhook_signing_secret");
      expect(sealed?.ciphertext).not.toContain(created.secret);
      expect(await secretStore.readSecret(db, { id: row?.secretRef ?? "", tenantId })).toBe(
        created.secret,
      );

      const fetched = await app.request(`/webhooks/${created.id}`, bearer(manager));
      const body = await fetched.text();
      expect(fetched.status).toBe(200);
      expect(body).not.toContain(created.secret);

      const [entry] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "webhook.created"), eq(auditLog.target, created.id)));
      expect(entry?.actor).toMatch(/^api-key:/);
      expect(entry?.details).toMatchObject({ urlOrigin: "https://dash.example.com" });
    });

    it("stores the format: restow by default, a chat format on request, changeable", async () => {
      const signed = await createHook({ url: "https://psa.example/hook", events: ["job.failed"] });
      expect((signed as CreatedHook & { format: string }).format).toBe("restow");
      const chat = (await createHook({
        url: "https://discord.com/api/webhooks/1/token",
        events: ["job.failed"],
        format: "discord",
      })) as CreatedHook & { format: string };
      expect(chat.format).toBe("discord");
      const [row] = await db.select().from(webhooks).where(eq(webhooks.id, chat.id));
      expect(row?.format).toBe("discord");

      const refused = await app.request("/webhooks", {
        method: "POST",
        headers: { authorization: `Bearer ${manager}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://x.example", events: ["job.failed"], format: "irc" }),
      });
      expect(refused.status).toBe(422);

      const patched = await app.request(`/webhooks/${chat.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${manager}`, "content-type": "application/json" },
        body: JSON.stringify({ format: "slack" }),
      });
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as { format: string }).format).toBe("slack");
      const [entry] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "webhook.updated"), eq(auditLog.target, chat.id)));
      expect(entry?.details).toMatchObject({ format: "slack" });
    });

    it("fans an emitted event out to subscribed, active webhooks only", async () => {
      const failed = await createHook({ url: "https://a.example/hook", events: ["job.failed"] });
      const completed = await createHook({
        url: "https://b.example/hook",
        events: ["job.completed"],
      });
      const paused = await createHook({
        url: "https://c.example/hook",
        events: ["job.failed"],
        active: false,
      });

      const emitted = await lib.emitWebhookEvent(db, {
        tenantId,
        event: "job.failed",
        data: { job: { id: "j-1", queue: "backup" } },
      });
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.tenantId, tenantId));
      const targets = rows
        .filter((row) => emitted.deliveryIds.includes(row.id))
        .map((row) => row.webhookId);
      expect(targets).toContain(failed.id);
      expect(targets).not.toContain(completed.id);
      expect(targets).not.toContain(paused.id);
      const mine = rows.find((row) => row.webhookId === failed.id);
      expect(mine).toMatchObject({ status: "pending", attempts: 0, event: "job.failed" });
      expect(mine?.payload).toMatchObject({
        id: emitted.eventId,
        event: "job.failed",
        version: 1,
        tenantId,
        data: { job: { id: "j-1", queue: "backup" } },
      });
    });

    it("joins the caller's transaction, so a rolled-back change emits nothing", async () => {
      const hook = await createHook({
        url: "https://tx.example/hook",
        events: ["verify.completed"],
      });
      await expect(
        db.transaction(async (tx) => {
          await lib.emitWebhookEvent(tx, { tenantId, event: "verify.completed", data: {} });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, hook.id));
      expect(rows).toHaveLength(0);
    });

    it("pages the delivery log newest first without gaps", async () => {
      const hook = await createHook({ url: "https://log.example/hook", events: ["job.completed"] });
      for (let i = 0; i < 5; i++) {
        await lib.emitWebhookEvent(db, { tenantId, event: "job.completed", data: { n: i } });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "2", ...(cursor ? { cursor } : {}) });
        const response = await app.request(
          `/webhooks/${hook.id}/deliveries?${query.toString()}`,
          bearer(manager),
        );
        expect(response.status).toBe(200);
        const page = (await response.json()) as { items: { id: string }[]; next: string | null };
        seen.push(...page.items.map((item) => item.id));
        cursor = page.next;
      } while (cursor);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);

      const all = await hooks.listDeliveries(db, tenantId, hook.id, { limit: 50 });
      expect(all.items.map((item) => item.id)).toEqual(seen);
      const listed = (await hooks.listWebhooks(db, tenantId)).find((item) => item.id === hook.id);
      expect(listed?.stats.pending).toBe(5);
      expect(listed?.stats.lastDelivery?.id).toBe(seen[0]);

      // The same log as CSV, for proof that a receiver was told.
      const csv = await app.request(`/webhooks/${hook.id}/deliveries/export`, bearer(manager));
      expect(csv.status).toBe(200);
      expect(csv.headers.get("content-type")).toContain("text/csv");
      const lines = (await csv.text())
        .replace(/^\uFEFF/, "")
        .trim()
        .split("\r\n");
      expect(lines[0]).toBe(
        "createdAt,event,eventId,status,attempts,deliveredAt,error,httpStatus,detail",
      );
      expect(lines).toHaveLength(6);
    });

    it("queues test events and redelivers finished deliveries with the same event id", async () => {
      const hook = await createHook({ url: "https://test.example/hook", events: ["job.failed"] });
      const test = await app.request(`/webhooks/${hook.id}/test`, {
        method: "POST",
        ...bearer(manager),
      });
      expect(test.status).toBe(202);
      const delivery = (await test.json()) as { id: string; event: string; eventId: string };
      expect(delivery.event).toBe("webhook.test");

      const early = await app.request(`/webhooks/${hook.id}/deliveries/${delivery.id}/redeliver`, {
        method: "POST",
        ...bearer(manager),
      });
      expect(early.status).toBe(409);

      await db
        .update(webhookDeliveries)
        .set({ status: "failed", attempts: 8, lastError: "http_error 500: boom" })
        .where(eq(webhookDeliveries.id, delivery.id));
      const again = await hooks.redeliver(db, tenantId, hook.id, delivery.id, actor());
      expect(again.id).not.toBe(delivery.id);
      expect(again).toMatchObject({ status: "pending", attempts: 0, eventId: delivery.eventId });

      const detail = await hooks.getDelivery(db, tenantId, hook.id, delivery.id);
      expect(detail.lastError).toEqual({ code: "http_error", httpStatus: 500, detail: "boom" });
      expect(detail.payload).toMatchObject({ event: "webhook.test", data: { test: true } });
    });

    it("ends queued deliveries visibly when a webhook is paused", async () => {
      const hook = await createHook({ url: "https://pause.example/hook", events: ["job.failed"] });
      await lib.emitWebhookEvent(db, { tenantId, event: "job.failed", data: {} });
      const response = await app.request(`/webhooks/${hook.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${manager}`, "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      expect(response.status).toBe(200);
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, hook.id));
      expect(rows.every((row) => row.status === "failed")).toBe(true);
      expect(rows[0]?.lastError).toBe("webhook_disabled");
      await expect(hooks.sendTestEvent(db, tenantId, hook.id, actor())).rejects.toMatchObject({
        status: 409,
      });
    });

    it("rotates the secret and deletes the webhook with its deliveries and secret", async () => {
      const hook = await createHook({ url: "https://rotate.example/hook", events: ["job.failed"] });
      const rotated = await hooks.rotateWebhookSecret(db, tenantId, hook.id, actor());
      expect(rotated.secret).not.toBe(hook.secret);
      const [row] = await db.select().from(webhooks).where(eq(webhooks.id, hook.id));
      const ref = { id: row?.secretRef ?? "", tenantId };
      expect(await secretStore.readSecret(db, ref)).toBe(rotated.secret);

      await lib.emitWebhookEvent(db, { tenantId, event: "job.failed", data: {} });
      const deleted = await app.request(`/webhooks/${hook.id}`, {
        method: "DELETE",
        ...bearer(manager),
      });
      expect(deleted.status).toBe(204);
      expect(await db.select().from(webhooks).where(eq(webhooks.id, hook.id))).toHaveLength(0);
      expect(
        await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.id)),
      ).toHaveLength(0);
      expect(await secretStore.readSecret(db, ref)).toBeNull();
      expect((await app.request(`/webhooks/${hook.id}`, bearer(manager))).status).toBe(404);
    });
  });
});
