import type { AuditLogEntry } from "@restow/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { errorHandler, notFoundHandler } from "../../problem.js";
import { buildV1 } from "../v1.js";
import { toJsonSchema } from "./openapi.js";
import { mailboxesOf, tenantSchema } from "./tenant.js";
import { featuresOn } from "./testing/features.js";
import { OTHER_TENANT_ID, TENANT_ID, bearer, fakeRequireKey } from "./testing/keys.js";
import { scriptedDb } from "./testing/scripted-db.js";
import { protectionStatusOf } from "./users.js";

// The counting rule comes from the @restow/core source (independent of its build output).
vi.mock("@restow/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../../packages/core/src/usage/mailboxes.js",
  )),
}));

describe("mailboxesOf", () => {
  it("reports the tenant's own count and cap, and no limit", () => {
    expect(mailboxesOf({ used: 40, cap: null, installationUsed: 90 }, "tenant")).toEqual({
      used: 40,
      cap: null,
    });
    expect(mailboxesOf({ used: 48, cap: 50, installationUsed: 100 }, "tenant")).toEqual({
      used: 48,
      cap: 50,
    });
  });

  it("does not turn a cap that is already exceeded into a block", () => {
    expect(mailboxesOf({ used: 60, cap: 50, installationUsed: 60 }, "tenant")).toEqual({
      used: 60,
      cap: 50,
    });
  });

  it("adds the installation's usage for a provider", () => {
    expect(mailboxesOf({ used: 40, cap: 100, installationUsed: 200 }, "provider")).toEqual({
      used: 40,
      cap: 100,
      installationUsed: 200,
    });
  });

  it("leaves the installation's usage out for a tenant", () => {
    const own = mailboxesOf({ used: 40, cap: 100, installationUsed: 200 }, "tenant");
    expect(own).not.toHaveProperty("installationUsed");
  });
});

describe("GET /tenant", () => {
  const tenantRow = {
    id: TENANT_ID,
    name: "Contoso",
    slug: "contoso",
    status: "active",
    mailboxCap: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  /** The queries of GET /tenant, in the order the route awaits them. */
  function tenantQueries(): unknown[][] {
    return [
      // The key's tenant.
      [tenantRow],
      // Every tenant of the installation, then each one's protected objects.
      [
        { id: TENANT_ID, name: "Contoso", slug: "contoso", status: "active", cap: null },
        { id: OTHER_TENANT_ID, name: "Fabrikam", slug: "fabrikam", status: "active", cap: null },
      ],
      [
        { kind: "mailbox", status: "active", userId: "user-a" },
        { kind: "onedrive", status: "active", userId: "user-a" },
        { kind: "mailbox", status: "active", userId: "user-b" },
      ],
      [
        { kind: "mailbox", status: "active", userId: "user-c" },
        { kind: "mailbox", status: "active", userId: "user-d" },
        { kind: "imap", status: "active", userId: null },
      ],
      // Storage targets, retention policies and active legal holds of the tenant.
      [],
      [],
      [{ active: 0 }],
    ];
  }

  function setup() {
    const script = scriptedDb(tenantQueries());
    const api = buildV1({
      db: script.db,
      providerDb: script.db,
      requireKey: fakeRequireKey,
      requireFeature: featuresOn,
      audit: async () => ({}) as AuditLogEntry,
      version: {
        current: () => ({
          running: "1.4.0",
          commit: null,
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
      now: () => new Date("2026-09-23T10:00:00.000Z"),
    });
    const app = new Hono();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);
    app.route("/api/v1", api.app);
    return { app, script };
  }

  async function mailboxesFor(key: string): Promise<Record<string, unknown>> {
    const { app, script } = setup();
    const res = await app.request("/api/v1/tenant", {
      headers: { ...bearer(key), "x-restow-tenant": TENANT_ID },
    });
    expect(res.status).toBe(200);
    expect(script.pending()).toBe(0);
    const body = (await res.json()) as { mailboxes: Record<string, unknown> };
    return body.mailboxes;
  }

  it("does not show a tenant key how many mailboxes the whole installation protects", async () => {
    const mailboxes = await mailboxesFor("rsk_tenant_full");
    // Contoso's own count: two mailboxes (the OneDrive next to a mailbox is free).
    expect(mailboxes.used).toBe(2);
    expect(mailboxes).not.toHaveProperty("installationUsed");
    expect(mailboxes).toHaveProperty("cap");
    expect(mailboxes).not.toHaveProperty("remaining");
    expect(mailboxes).not.toHaveProperty("bindingLimit");
  });

  it("shows a provider key the usage across the installation", async () => {
    const mailboxes = await mailboxesFor("rsk_provider_full");
    expect(mailboxes.used).toBe(2);
    expect(mailboxes.installationUsed).toBe(5);
  });

  it("documents the installation figure as optional", () => {
    const mailboxes = toJsonSchema(tenantSchema.shape.mailboxes, "output") as {
      required: string[];
      properties: Record<string, { description?: string }>;
    };
    expect(mailboxes.required).toEqual(expect.arrayContaining(["used", "cap"]));
    expect(mailboxes.required).not.toContain("installationUsed");
    expect(mailboxes.properties.installationUsed?.description).toContain("provider keys");
  });
});

describe("protectionStatusOf", () => {
  it("summarizes a user's objects, protected wins", () => {
    expect(protectionStatusOf([])).toBe("none");
    expect(protectionStatusOf(["excluded", "active"])).toBe("active");
    expect(protectionStatusOf(["orphaned", "excluded"])).toBe("excluded");
    expect(protectionStatusOf(["orphaned"])).toBe("orphaned");
  });
});
