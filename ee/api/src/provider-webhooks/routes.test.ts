import type { AuditLogEntry } from "@restow/db";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import { errorHandler, notFoundHandler } from "../../../../apps/api/src/problem.js";
import { featuresOff, featuresOn } from "../../../../apps/api/src/routes/v1/testing/features.js";
import { bearer, fakeRequireKey } from "../../../../apps/api/src/routes/v1/testing/keys.js";
import { scriptedDb } from "../../../../apps/api/src/routes/v1/testing/scripted-db.js";
import { buildV1 } from "../../../../apps/api/src/routes/v1.js";

/**
 * The provider's own webhooks on the integration API (0.6.0): provider keys with
 * `webhooks:manage` only, Service Provider only, the key named as the actor of each change.
 * The service is replaced at its module boundary (its database behaviour is proved in
 * ../billing-close/billing-close.pg.test.ts).
 */

const mocks = vi.hoisted(() => ({
  listProviderWebhooks: vi.fn(),
  createProviderWebhook: vi.fn(),
  deleteProviderWebhook: vi.fn(),
  sendProviderWebhookTest: vi.fn(),
}));

vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...mocks,
}));

const { registerProviderWebhookRoutes } = await import("./routes.js");

const HOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const hook = {
  id: HOOK,
  name: "PSA",
  url: "https://psa.example/hook",
  events: ["billing.period_closed"],
  active: true,
  failingSince: null,
  consecutiveFailures: 0,
  lastFailure: null,
  pending: 0,
  lastDelivery: null,
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-01T08:00:00.000Z",
};

function setup(requireFeature = featuresOn) {
  const script = scriptedDb([]);
  const api = buildV1({
    db: script.db,
    providerDb: script.db,
    requireKey: fakeRequireKey,
    requireFeature,
    audit: async () => ({}) as AuditLogEntry,
    version: {
      current: () => ({
        running: "1.4.0",
        commit: null,
        releasedAt: null,
        latest: null,
        updateAvailable: null,
        releaseUrl: null,
        updateCheck: "disabled",
        checkedAt: null,
        channel: "stable",
        latestTag: null,
        publishedAt: null,
        checkError: null,
        maintenance: null,
      }),
    },
    now: () => new Date("2026-11-17T10:00:00.000Z"),
  });
  const app = new Hono();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.route("/api/v1", api.app);
  return (path: string, init: RequestInit & { key?: string } = {}) => {
    const { key = "rsk_provider_full", ...rest } = init;
    return app.request(`/api/v1${path}`, {
      ...rest,
      headers: {
        ...bearer(key),
        "x-forwarded-for": "203.0.113.7",
        ...(rest.body ? { "content-type": "application/json" } : {}),
      },
    });
  };
}

beforeAll(() => {
  registerApiExtension({
    name: "provider-webhooks-test",
    integrationRoutes: [registerProviderWebhookRoutes],
  });
});

afterAll(() => {
  resetExtensionsForTesting();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/provider/webhooks", () => {
  it("lists and creates with a provider key carrying webhooks:manage, the key as the actor", async () => {
    mocks.listProviderWebhooks.mockResolvedValue({
      items: [hook],
      events: ["billing.period_closed"],
    });
    mocks.createProviderWebhook.mockResolvedValue({ ...hook, secret: "whsec_x" });
    const request = setup();
    const list = await request("/provider/webhooks");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ id: HOOK }] });
    const created = await request("/provider/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://psa.example/hook", name: "PSA" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ secret: "whsec_x" });
    expect(mocks.createProviderWebhook).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: "https://psa.example/hook", active: true }),
      { label: "api-key:key-provider", userId: null, ip: "203.0.113.7", keyId: "key-provider" },
    );
  });

  it("refuses unknown events and a URL with credentials", async () => {
    const request = setup();
    for (const body of [
      { url: "https://psa.example/hook", events: ["job.failed"] },
      { url: "https://user:secret@psa.example/hook" },
    ]) {
      const res = await request("/provider/webhooks", {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect([400, 422]).toContain(res.status);
    }
    expect(mocks.createProviderWebhook).not.toHaveBeenCalled();
  });

  it("deletes and tests one webhook", async () => {
    mocks.sendProviderWebhookTest.mockResolvedValue({
      id: "bbbbbbbb-2222-4222-8222-222222222222",
      event: "webhook.test",
      eventId: "evt",
      status: "pending",
      attempts: 0,
      maxAttempts: 8,
      lastError: null,
      nextAttemptAt: "2026-11-17T10:00:00.000Z",
      deliveredAt: null,
      createdAt: "2026-11-17T10:00:00.000Z",
    });
    const request = setup();
    expect((await request(`/provider/webhooks/${HOOK}/test`, { method: "POST" })).status).toBe(202);
    expect((await request(`/provider/webhooks/${HOOK}`, { method: "DELETE" })).status).toBe(204);
    expect(mocks.deleteProviderWebhook).toHaveBeenCalledWith(
      expect.anything(),
      HOOK,
      expect.objectContaining({ keyId: "key-provider" }),
    );
  });

  it("is closed to tenant keys, to provider keys without webhooks:manage and below Service Provider", async () => {
    const request = setup();
    expect((await request("/provider/webhooks", { key: "rsk_tenant_full" })).status).toBe(403);
    expect((await request("/provider/webhooks", { key: "rsk_provider_status" })).status).toBe(403);
    const locked = setup(featuresOff);
    expect((await locked("/provider/webhooks")).status).toBe(403);
    expect(mocks.listProviderWebhooks).not.toHaveBeenCalled();
  });
});
