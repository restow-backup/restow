import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";

import {
  DELIVERY_STATUS_VARIANT,
  HEALTH_VARIANT,
  KEY_STATUS_VARIANT,
  SCOPE_GROUPS,
  apiKeyFormSchema,
  deliveryErrorKey,
  deliveryStatusOf,
  detectWebhookFormat,
  displayUrl,
  eventKey,
  expiresSoon,
  expiryDays,
  formatFollowsUrl,
  hasPendingDelivery,
  integrationErrorKey,
  isInsecureUrl,
  isSignedFormat,
  needsNewSecret,
  parseIntegrationsSearch,
  scopeKey,
  sortScopes,
  suggestedFormat,
  toCreateApiKeyInput,
  toWebhookInput,
  toggleItem,
  visibleKeys,
  webhookFormFrom,
  webhookFormSchema,
  webhookHealth,
  webhookPatch,
  webhookUrlIssue,
} from "./presenters";
import { API_SCOPES, type ApiKey, WEBHOOK_EVENTS, WEBHOOK_FORMATS, type Webhook } from "./types";

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "k-1",
    kind: "tenant",
    tenantId: "t-1",
    name: "RMM",
    prefix: "rsk_contoso_AbCdEfGh",
    scopes: ["status:read"],
    status: "active",
    createdAt: "2026-09-01T08:00:00.000Z",
    createdBy: null,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: "w-1",
    name: "RMM",
    url: "https://dash.example.com/hooks/restow",
    events: ["job.failed"],
    active: true,
    format: "restow",
    secretConfigured: true,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    stats: { pending: 0, failedLast24h: 0, deliveredLast24h: 0, lastDelivery: null },
    ...overrides,
  };
}

function problem(type: string, status = 409) {
  return new ApiError(status, { type, title: "x", status }, "x");
}

describe("scopes", () => {
  it("group every scope exactly once", () => {
    const grouped = SCOPE_GROUPS.flatMap((group) => group.scopes);
    expect([...grouped].sort()).toEqual([...API_SCOPES].sort());
    expect(new Set(grouped).size).toBe(API_SCOPES.length);
  });

  it("have i18n-safe ids and a canonical order", () => {
    expect(scopeKey("status:read")).toBe("status_read");
    expect(sortScopes(["webhooks:manage", "status:read", "status:read"])).toEqual([
      "status:read",
      "webhooks:manage",
    ]);
  });

  it("toggle in the given order", () => {
    expect(toggleItem(["b"], "a", true, ["a", "b", "c"])).toEqual(["a", "b"]);
    expect(toggleItem(["a", "b"], "a", false, ["a", "b", "c"])).toEqual(["b"]);
    expect(toggleItem(["a"], "a", true, ["a", "b"])).toEqual(["a"]);
  });
});

describe("API key form", () => {
  it("requires a name and at least one scope", () => {
    const result = apiKeyFormSchema.safeParse({ name: " ", scopes: [], expiry: "never" });
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages).toEqual(["nameRequired", "scopesRequired"]);
  });

  it("becomes the API request", () => {
    expect(
      toCreateApiKeyInput({
        name: "  RMM tickets ",
        scopes: ["webhooks:manage", "status:read"],
        expiry: "90",
      }),
    ).toEqual({
      name: "RMM tickets",
      scopes: ["status:read", "webhooks:manage"],
      expiresInDays: 90,
    });
    expect(expiryDays("never")).toBeNull();
  });
});

describe("key lists", () => {
  it("show usable keys first and revoked keys only on request", () => {
    const keys = [
      apiKey({ id: "revoked", status: "revoked", createdAt: "2026-09-05T00:00:00.000Z" }),
      apiKey({ id: "old", createdAt: "2026-09-01T00:00:00.000Z" }),
      apiKey({ id: "expired", status: "expired", createdAt: "2026-09-04T00:00:00.000Z" }),
      apiKey({ id: "new", createdAt: "2026-09-03T00:00:00.000Z" }),
    ];
    expect(visibleKeys(keys, false).map((key) => key.id)).toEqual(["new", "old", "expired"]);
    expect(visibleKeys(keys, true).map((key) => key.id)).toEqual([
      "new",
      "old",
      "expired",
      "revoked",
    ]);
  });

  it("warn two weeks before a key expires", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    expect(expiresSoon(apiKey({ expiresAt: "2026-10-01T00:00:00.000Z" }), now)).toBe(true);
    expect(expiresSoon(apiKey({ expiresAt: "2026-12-01T00:00:00.000Z" }), now)).toBe(false);
    expect(expiresSoon(apiKey({ expiresAt: null }), now)).toBe(false);
    expect(
      expiresSoon(apiKey({ status: "revoked", expiresAt: "2026-09-24T00:00:00.000Z" }), now),
    ).toBe(false);
  });
});

describe("events", () => {
  it("map to i18n-safe ids, unknown ones to a shared entry", () => {
    expect(WEBHOOK_EVENTS.map(eventKey)).toEqual([
      "job_failed",
      "job_completed",
      "verify_completed",
    ]);
    expect(eventKey("license.expiring")).toBe("unknown");
    expect(eventKey("webhook.test")).toBe("webhook_test");
    expect(eventKey("backup.started")).toBe("unknown");
  });
});

describe("webhooks", () => {
  it("flag plain http targets", () => {
    expect(isInsecureUrl("http://10.0.0.5/hook")).toBe(true);
    expect(isInsecureUrl(" HTTP://rmm.local")).toBe(true);
    expect(isInsecureUrl("https://rmm.example.com")).toBe(false);
  });

  it("display host and path", () => {
    expect(displayUrl("https://rmm.example.com:8443/hooks/restow?token=abc")).toBe(
      "rmm.example.com:8443/hooks/restow",
    );
    expect(displayUrl("https://rmm.example.com/")).toBe("rmm.example.com");
    expect(displayUrl("not a url")).toBe("not a url");
  });

  it("judge health by the last delivery", () => {
    const last = (status: "pending" | "delivered" | "failed") => ({
      pending: 0,
      failedLast24h: 0,
      deliveredLast24h: 0,
      lastDelivery: { id: "d", event: "job.failed", status, createdAt: "", deliveredAt: null },
    });
    expect(webhookHealth(webhook({ active: false, stats: last("failed") }))).toBe("paused");
    expect(webhookHealth(webhook({ stats: last("failed") }))).toBe("failing");
    expect(webhookHealth(webhook({ stats: last("pending") }))).toBe("retrying");
    expect(webhookHealth(webhook({ stats: last("delivered") }))).toBe("healthy");
    expect(webhookHealth(webhook())).toBe("idle");
  });

  it("validate URLs like the API", () => {
    expect(webhookUrlIssue("https://rmm.example.com/hook")).toBeNull();
    expect(webhookUrlIssue("rmm.example.com")).toBe("url");
    expect(webhookUrlIssue("ftp://rmm.example.com")).toBe("scheme");
    expect(webhookUrlIssue("https://a:b@rmm.example.com")).toBe("credentials");
  });

  it("validate the form with translatable reasons", () => {
    const result = webhookFormSchema.safeParse({
      name: "",
      url: "ftp://x",
      events: [],
      active: true,
      format: "restow",
    });
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    // No event is allowed: a webhook only rules send to.
    expect(messages).toEqual(["scheme"]);
    expect(
      webhookFormSchema.safeParse({
        name: "",
        url: "",
        events: ["job.failed"],
        active: true,
        format: "restow",
      }).success,
    ).toBe(false);
  });

  it("round-trip between form and API", () => {
    const hook = webhook({ name: null, events: ["job.completed", "job.failed"] });
    const values = webhookFormFrom(hook);
    expect(values).toEqual({
      name: "",
      url: hook.url,
      events: ["job.completed", "job.failed"],
      active: true,
      format: "restow",
    });
    expect(toWebhookInput({ ...values, name: "  " })).toEqual({
      name: null,
      url: hook.url,
      events: ["job.failed", "job.completed"],
      active: true,
      format: "restow",
    });
    expect(webhookFormFrom()).toMatchObject({
      events: ["job.failed"],
      active: true,
      format: "restow",
    });
    expect(webhookFormFrom(webhook({ format: "slack" })).format).toBe("slack");
  });

  it("patch only what changed", () => {
    const hook = webhook();
    expect(webhookPatch(webhookFormFrom(hook), hook)).toEqual({});
    expect(
      webhookPatch(
        { ...webhookFormFrom(hook), events: ["job.completed", "job.failed"], active: false },
        hook,
      ),
    ).toEqual({ events: ["job.failed", "job.completed"], active: false });
    expect(webhookPatch({ ...webhookFormFrom(hook), name: "" }, hook)).toEqual({ name: null });
    expect(webhookPatch({ ...webhookFormFrom(hook), format: "teams" }, hook)).toEqual({
      format: "teams",
    });
  });

  it("validate the format", () => {
    const base = { name: "", url: "https://x.example", events: ["job.failed"], active: true };
    for (const format of WEBHOOK_FORMATS) {
      expect(webhookFormSchema.safeParse({ ...base, format }).success).toBe(true);
    }
    expect(webhookFormSchema.safeParse({ ...base, format: "teams2" }).success).toBe(false);
  });
});

describe("webhook formats", () => {
  it.each([
    ["https://discord.com/api/webhooks/123/abcDEF", "discord"],
    ["https://discordapp.com/api/webhooks/123/abc", "discord"],
    ["https://ptb.discord.com/api/webhooks/123/abc", "discord"],
    ["https://canary.discord.com/api/v10/webhooks/123/abc", "discord"],
    ["  https://DISCORD.com/api/webhooks/123/abc  ", "discord"],
    ["https://hooks.slack.com/services/T000/B000/XXXX", "slack"],
    ["https://hooks.slack.com/triggers/T000/123/abc", "slack"],
    ["https://contoso.webhook.office.com/webhookb2/abc@def/IncomingWebhook/x/y", "teams"],
    [
      "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=x",
      "teams",
    ],
    [
      "https://default1234.56.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=x",
      "teams",
    ],
    ["https://flow.powerautomate.com/webhooks/abc", "teams"],
  ])("recognise %s as %s", (url, format) => {
    expect(detectWebhookFormat(url)).toBe(format);
    expect(suggestedFormat(url)).toBe(format);
  });

  it.each([
    "https://discord.com/channels/1/2",
    "https://discord.com.evil.example/api/webhooks/1/2",
    "https://evildiscord.com/api/webhooks/1/2",
    "https://slack.com/hooks/abc",
    "https://hooks.slack.com.evil.example/services/x",
    "https://webhook.office.com.evil.example/x",
    "https://notlogic.azure.com/x",
    "https://rmm.example.com/hooks/restow",
    "ftp://hooks.slack.com/services/x",
    "not a url",
    "",
  ])("leave %s to the signed format", (url) => {
    expect(detectWebhookFormat(url)).toBeNull();
    expect(suggestedFormat(url)).toBe("restow");
  });

  it("sign only the restow format", () => {
    expect(WEBHOOK_FORMATS.filter(isSignedFormat)).toEqual(["restow"]);
  });

  it("follow the URL for a new webhook and while the stored format matches the URL", () => {
    expect(formatFollowsUrl()).toBe(true);
    expect(formatFollowsUrl(webhook())).toBe(true);
    expect(
      formatFollowsUrl(webhook({ url: "https://discord.com/api/webhooks/1/x", format: "discord" })),
    ).toBe(true);
    // A deliberate choice that differs from the URL stays.
    expect(
      formatFollowsUrl(webhook({ url: "https://discord.com/api/webhooks/1/x", format: "restow" })),
    ).toBe(false);
    expect(formatFollowsUrl(webhook({ format: "teams" }))).toBe(false);
  });

  it("show a new secret only when a chat webhook becomes signed", () => {
    expect(needsNewSecret(webhook({ format: "discord" }), "restow")).toBe(true);
    expect(needsNewSecret(webhook({ format: "restow" }), "restow")).toBe(false);
    expect(needsNewSecret(webhook({ format: "restow" }), "slack")).toBe(false);
    expect(needsNewSecret(undefined, "restow")).toBe(false);
  });
});

describe("deliveries", () => {
  it("translate failures by code", () => {
    expect(deliveryErrorKey({ code: "http_error", httpStatus: 500, detail: null })).toBe(
      "deliveries.errors.http_error",
    );
  });

  it("know when to keep refreshing", () => {
    expect(hasPendingDelivery([{ status: "delivered" }, { status: "pending" }])).toBe(true);
    expect(hasPendingDelivery([{ status: "failed" }])).toBe(false);
    expect(hasPendingDelivery([])).toBe(false);
  });

  it("map the filter to the API status", () => {
    expect(deliveryStatusOf("all")).toBeNull();
    expect(deliveryStatusOf("failed")).toBe("failed");
  });
});

describe("integrationErrorKey", () => {
  it("names known problems of this feature", () => {
    expect(integrationErrorKey(problem("urn:restow:problem:api-key-limit"))).toBe(
      "integrations:problems.keyLimit",
    );
    // Provider keys refused on this installation, by the core or by an extension.
    expect(integrationErrorKey(problem("urn:restow:problem:feature-unavailable", 403))).toBe(
      "integrations:problems.featureUnavailable",
    );
    expect(integrationErrorKey(problem("urn:restow:problem:edition-required", 403))).toBe(
      "integrations:problems.featureUnavailable",
    );
    expect(integrationErrorKey(problem("urn:restow:problem:webhook-paused"))).toBe(
      "integrations:problems.webhookPaused",
    );
  });

  it("falls back to the common error texts", () => {
    expect(integrationErrorKey(problem("about:blank", 404))).toBe("common:errors.notFound");
    expect(integrationErrorKey(new NetworkError(new Error("offline")))).toBe(
      "common:errors.network",
    );
  });
});

describe("parseIntegrationsSearch", () => {
  it("keeps only known tabs", () => {
    expect(parseIntegrationsSearch({ tab: "webhooks" })).toEqual({ tab: "webhooks" });
    expect(parseIntegrationsSearch({ tab: "api-keys" })).toEqual({});
    expect(parseIntegrationsSearch({ tab: "<script>" })).toEqual({});
  });
});

describe("badge variants", () => {
  it("keep green out of keys, webhooks and deliveries: a state is not a passed restore check", () => {
    const all = [
      ...Object.values(KEY_STATUS_VARIANT),
      ...Object.values(HEALTH_VARIANT),
      ...Object.values(DELIVERY_STATUS_VARIANT),
    ];
    expect(all).not.toContain("success");
    expect(KEY_STATUS_VARIANT.active).toBe("outline");
    expect(HEALTH_VARIANT.healthy).toBe("outline");
    expect(DELIVERY_STATUS_VARIANT.delivered).toBe("outline");
    // Problems keep their colours.
    expect(HEALTH_VARIANT.failing).toBe("destructive");
    expect(DELIVERY_STATUS_VARIANT.failed).toBe("destructive");
  });
});
