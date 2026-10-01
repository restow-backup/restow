import type { Webhook, WebhookDelivery } from "@restow/db";
import { describe, expect, it } from "vitest";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PAYLOAD_VERSION,
  buildWebhookEnvelope,
  generateWebhookSecret,
  isWebhookEvent,
} from "../../lib/webhooks.js";
import { ProblemError } from "../../problem.js";
import { decodeDeliveryCursor, encodeDeliveryCursor } from "./cursor.js";
import { parseDeliveryError } from "./delivery-error.js";
import {
  createWebhookSchema,
  deliveriesQuerySchema,
  updateWebhookSchema,
  webhookUrlIssue,
} from "./schemas.js";
import { describeChanges, toDeliveryDto, toWebhookDto, urlOrigin } from "./service.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const HOOK = "22222222-2222-4222-8222-222222222222";
const DELIVERY = "33333333-3333-4333-8333-333333333333";

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: HOOK,
    tenantId: TENANT,
    name: "RMM",
    url: "https://dash.example.com/hooks/restow",
    secretRef: "44444444-4444-4444-8444-444444444444",
    events: ["job.failed", "job.completed"],
    active: true,
    createdAt: new Date("2026-09-01T08:00:00Z"),
    updatedAt: new Date("2026-09-02T08:00:00Z"),
    ...overrides,
  };
}

function delivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: DELIVERY,
    tenantId: TENANT,
    webhookId: HOOK,
    event: "job.failed",
    payload: { id: "evt-1", event: "job.failed" },
    status: "pending",
    attempts: 2,
    lastError: "http_error 503: maintenance",
    nextAttemptAt: new Date("2026-09-23T12:05:00Z"),
    deliveredAt: null,
    createdAt: new Date("2026-09-23T12:00:00Z"),
    updatedAt: new Date("2026-09-23T12:01:00Z"),
    ...overrides,
  };
}

describe("webhook events and envelope", () => {
  it("are exactly the events something raises", () => {
    expect([...WEBHOOK_EVENTS]).toEqual(["job.failed", "job.completed", "verify.completed"]);
    // Planned events stay unsubscribable until they have an emitter.
    expect(isWebhookEvent("storage.quota")).toBe(false);
    expect(isWebhookEvent("job.failed")).toBe(true);
    expect(isWebhookEvent("webhook.test")).toBe(false);
  });

  it("wraps event data in a versioned envelope", () => {
    const envelope = buildWebhookEnvelope(
      {
        tenantId: TENANT,
        event: "job.failed",
        data: { job: { id: "j-1" } },
        occurredAt: new Date("2026-09-23T10:00:00Z"),
      },
      "evt-1",
    );
    expect(envelope).toEqual({
      id: "evt-1",
      event: "job.failed",
      version: WEBHOOK_PAYLOAD_VERSION,
      createdAt: "2026-09-23T10:00:00.000Z",
      tenantId: TENANT,
      data: { job: { id: "j-1" } },
    });
  });

  it("gives every event its own id", () => {
    const input = { tenantId: TENANT, event: "job.completed" as const, data: {} };
    expect(buildWebhookEnvelope(input).id).not.toBe(buildWebhookEnvelope(input).id);
  });

  it("generates signing secrets with 256 bits of randomness", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(secret);
  });
});

describe("webhookUrlIssue", () => {
  it("accepts absolute http and https URLs", () => {
    expect(webhookUrlIssue("https://rmm.example.com/hooks/restow?tenant=1")).toBeNull();
    expect(webhookUrlIssue("http://10.0.0.5:8080/restow")).toBeNull();
  });

  it("names what is wrong", () => {
    expect(webhookUrlIssue("rmm.example.com/hook")).toBe("invalid");
    expect(webhookUrlIssue("ftp://rmm.example.com/hook")).toBe("scheme");
    expect(webhookUrlIssue("javascript:alert(1)")).toBe("scheme");
    expect(webhookUrlIssue("https://user:pass@rmm.example.com/hook")).toBe("credentials");
  });
});

describe("webhook request schemas", () => {
  it("normalise a create request", () => {
    const parsed = createWebhookSchema.parse({
      name: "  ",
      url: " https://dash.example.com/hook ",
      events: ["job.completed", "job.failed", "job.failed"],
    });
    expect(parsed).toEqual({
      name: null,
      url: "https://dash.example.com/hook",
      // Deduplicated and in the documented order.
      events: ["job.failed", "job.completed"],
      active: true,
    });
  });

  it("accept the RMM contract shape (url and events only)", () => {
    expect(
      createWebhookSchema.safeParse({ url: "https://x.example", events: ["job.failed"] }).success,
    ).toBe(true);
  });

  it("refuse unknown events, empty subscriptions and bad URLs", () => {
    const base = { url: "https://x.example", events: ["job.failed"] };
    expect(createWebhookSchema.safeParse({ ...base, events: [] }).success).toBe(false);
    expect(createWebhookSchema.safeParse({ ...base, events: ["job.started"] }).success).toBe(false);
    expect(createWebhookSchema.safeParse({ ...base, url: "ftp://x.example" }).success).toBe(false);
  });

  it("need at least one change in an update", () => {
    expect(updateWebhookSchema.safeParse({}).success).toBe(false);
    expect(updateWebhookSchema.parse({ active: false })).toEqual({ active: false });
    expect(updateWebhookSchema.parse({ name: "" })).toEqual({ name: null });
  });

  it("bound the delivery page size", () => {
    expect(deliveriesQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(deliveriesQuerySchema.parse({ limit: "10", status: "failed" })).toEqual({
      limit: 10,
      status: "failed",
    });
    expect(deliveriesQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });
});

describe("parseDeliveryError", () => {
  it("reads code, status and detail", () => {
    expect(parseDeliveryError("http_error 503: maintenance window")).toEqual({
      code: "http_error",
      httpStatus: 503,
      detail: "maintenance window",
    });
    expect(parseDeliveryError("timeout")).toEqual({
      code: "timeout",
      httpStatus: null,
      detail: null,
    });
    expect(parseDeliveryError("connection_failed: ECONNREFUSED")).toEqual({
      code: "connection_failed",
      httpStatus: null,
      detail: "ECONNREFUSED",
    });
    expect(parseDeliveryError("redirect 301")).toEqual({
      code: "redirect",
      httpStatus: 301,
      detail: null,
    });
  });

  it("keeps multi-line details", () => {
    expect(parseDeliveryError("http_error 500: line one\nline two")?.detail).toBe(
      "line one\nline two",
    );
  });

  it("keeps anything unrecognised verbatim", () => {
    expect(parseDeliveryError("Something odd happened")).toEqual({
      code: "unknown",
      httpStatus: null,
      detail: "Something odd happened",
    });
    expect(parseDeliveryError("exploded: yes")?.code).toBe("unknown");
    expect(parseDeliveryError(null)).toBeNull();
    expect(parseDeliveryError("  ")).toBeNull();
  });
});

describe("delivery cursor", () => {
  it("round-trips at microsecond precision", () => {
    const cursor = { createdAt: "2026-09-23T12:00:00.123456Z", id: DELIVERY };
    expect(decodeDeliveryCursor(encodeDeliveryCursor(cursor))).toEqual(cursor);
  });

  it("rejects anything else with a 400 problem", () => {
    const bad = [
      "not-base64-json",
      Buffer.from("[1,2]").toString("base64url"),
      Buffer.from(JSON.stringify(["yesterday", DELIVERY])).toString("base64url"),
      Buffer.from(JSON.stringify(["2026-09-23T12:00:00Z", "x"])).toString("base64url"),
    ];
    for (const value of bad) {
      let caught: unknown;
      try {
        decodeDeliveryCursor(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProblemError);
      expect((caught as ProblemError).status).toBe(400);
    }
  });
});

describe("webhook DTOs", () => {
  it("expose the webhook without its secret", () => {
    const dto = toWebhookDto(webhook({ events: ["job.completed", "retired.event", "job.failed"] }));
    expect(dto).toMatchObject({
      id: HOOK,
      name: "RMM",
      url: "https://dash.example.com/hooks/restow",
      events: ["job.failed", "job.completed"],
      active: true,
      secretConfigured: true,
      stats: { pending: 0, failedLast24h: 0, deliveredLast24h: 0, lastDelivery: null },
    });
    expect(JSON.stringify(dto)).not.toContain("44444444");
    expect(toWebhookDto(webhook({ secretRef: null })).secretConfigured).toBe(false);
  });

  it("describe a delivery with its parsed error and retry budget", () => {
    expect(toDeliveryDto(delivery())).toEqual({
      id: DELIVERY,
      webhookId: HOOK,
      event: "job.failed",
      eventId: "evt-1",
      status: "pending",
      attempts: 2,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      lastError: { code: "http_error", httpStatus: 503, detail: "maintenance" },
      nextAttemptAt: "2026-09-23T12:05:00.000Z",
      deliveredAt: null,
      createdAt: "2026-09-23T12:00:00.000Z",
      updatedAt: "2026-09-23T12:01:00.000Z",
    });
  });

  it("show no next attempt once a delivery is finished", () => {
    const finished = toDeliveryDto(delivery({ status: "failed" }));
    expect(finished.nextAttemptAt).toBeNull();
  });
});

describe("describeChanges", () => {
  it("lists changed fields only, the URL by origin", () => {
    const before = webhook();
    expect(
      describeChanges(before, {
        name: "RMM",
        url: "https://new.example.com/secret-token/hook?key=abc",
        events: ["job.completed", "job.failed"],
        active: false,
      }),
    ).toEqual({ urlOrigin: "https://new.example.com", active: false });
    expect(describeChanges(before, { events: ["job.failed"] })).toEqual({
      events: ["job.failed"],
    });
    expect(describeChanges(before, { name: null })).toEqual({ name: null });
  });

  it("reduce URLs to their origin", () => {
    expect(urlOrigin("https://hooks.example.com:8443/T0/B1/XYZ")).toBe(
      "https://hooks.example.com:8443",
    );
    expect(urlOrigin("nonsense")).toBe("invalid");
  });
});
