import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import { errorHandler } from "../../../../apps/api/src/problem.js";
import type { JsonSchema } from "../../../../apps/api/src/routes/v1/openapi.js";
import { featuresOn } from "../../../../apps/api/src/routes/v1/testing/features.js";
import { fakeRequireKey } from "../../../../apps/api/src/routes/v1/testing/keys.js";
import { scriptedDb } from "../../../../apps/api/src/routes/v1/testing/scripted-db.js";
import { buildV1 } from "../../../../apps/api/src/routes/v1.js";
import { registerProviderWebhookRoutes } from "../provider-webhooks/routes.js";
import { registerProviderRoutes } from "./routes.js";

/**
 * The provider operations in the integration API's OpenAPI document, with
 * the operations registered through the extension point exactly as
 * ee/api/src/index.ts does.
 */

registerApiExtension({
  name: "provider-api-openapi-test",
  integrationRoutes: [registerProviderRoutes, registerProviderWebhookRoutes],
});

afterAll(() => {
  resetExtensionsForTesting();
});

function integrationApi() {
  const script = scriptedDb([]);
  return buildV1({
    db: script.db,
    providerDb: script.db,
    requireKey: fakeRequireKey,
    requireFeature: featuresOn,
    audit: async () => {
      throw new Error("no audit expected");
    },
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
    now: () => new Date("2026-09-23T10:00:00.000Z"),
  });
}

describe("the provider operations in the v1 OpenAPI document", () => {
  const api = integrationApi();
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/v1", api.app);

  async function load(): Promise<JsonSchema> {
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    return (await res.json()) as JsonSchema;
  }

  it("documents the provider operations exactly once", async () => {
    const paths = (await load()).paths as Record<string, Record<string, JsonSchema>>;
    const documented = Object.entries(paths)
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .filter((operation) => operation.includes("/provider/"));
    expect(documented.sort()).toEqual([
      "DELETE /provider/webhooks/{id}",
      "GET /provider/billing",
      "GET /provider/billing/periods",
      "GET /provider/billing/periods/{period}",
      "GET /provider/tenants",
      "GET /provider/users",
      "GET /provider/webhooks",
      "GET /provider/webhooks/{id}",
      "GET /provider/webhooks/{id}/deliveries",
      "PATCH /provider/webhooks/{id}",
      "POST /provider/billing/periods/{period}/corrections",
      "POST /provider/webhooks",
      "POST /provider/webhooks/{id}/secret",
      "POST /provider/webhooks/{id}/test",
    ]);
  });

  it("names the scope of the provider operations, without the tenant header, and marks them audited", async () => {
    const paths = (await load()).paths as Record<string, Record<string, JsonSchema>>;
    const providerUsers = paths["/provider/users"]?.get as JsonSchema;
    expect(providerUsers.security).toEqual([{ apiKey: ["users:read"] }]);
    expect(JSON.stringify(providerUsers.parameters)).not.toContain("TenantHeader");
    expect(providerUsers["x-restow-audited"]).toBe(true);
    const billing = paths["/provider/billing"]?.get as JsonSchema;
    expect(billing.security).toEqual([{ apiKey: ["billing:read"] }]);
    expect(JSON.stringify(billing.parameters)).not.toContain("TenantHeader");
    expect(billing["x-restow-audited"]).toBe(true);
    // The closed months (0.6.0): read with billing:read and audited per tenant; corrected
    // with billing:write.
    const period = paths["/provider/billing/periods/{period}"]?.get as JsonSchema;
    expect(period.security).toEqual([{ apiKey: ["billing:read"] }]);
    expect(period["x-restow-audited"]).toBe(true);
    const periods = paths["/provider/billing/periods"]?.get as JsonSchema;
    expect(periods.security).toEqual([{ apiKey: ["billing:read"] }]);
    const correction = paths["/provider/billing/periods/{period}/corrections"]?.post as JsonSchema;
    expect(correction.security).toEqual([{ apiKey: ["billing:write"] }]);
    // The provider's own webhooks (0.6.0): the scope a key manages webhooks with.
    for (const [path, method] of [
      ["/provider/webhooks", "get"],
      ["/provider/webhooks", "post"],
      ["/provider/webhooks/{id}", "patch"],
      ["/provider/webhooks/{id}/test", "post"],
    ] as const) {
      expect((paths[path]?.[method] as JsonSchema | undefined)?.security).toEqual([
        { apiKey: ["webhooks:manage"] },
      ]);
    }
    expect(JSON.stringify(paths["/provider/webhooks"]?.post)).toContain("X-Restow-Signature");
    // Reading contact persons (personal data) through the provider tenant list
    // is a read of user data and must be audited, same as /provider/users.
    const providerTenants = paths["/provider/tenants"]?.get as JsonSchema;
    expect(providerTenants["x-restow-audited"]).toBe(true);
  });

  it("documents the tenant wizard's customer number and contacts for provider keys", async () => {
    const document = await load();
    const schemas = (document.components as { schemas: Record<string, JsonSchema> }).schemas;
    const providerTenant = schemas.ProviderTenant as JsonSchema;
    const properties = providerTenant.properties as Record<string, JsonSchema>;
    expect(properties.customerNumber).toMatchObject({ type: ["string", "null"] });
    expect(properties.contacts).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/ProviderTenantContact" },
    });
    // Contacts are personal data: the schema and the operation both document
    // that they stay empty without the extra scope (routes.ts gates them).
    expect(properties.contacts.description).toContain("users:read");
    const paths = (document.paths as Record<string, Record<string, JsonSchema>>)[
      "/provider/tenants"
    ];
    expect((paths?.get?.description as string) ?? "").toContain("users:read");
    const contact = schemas.ProviderTenantContact as JsonSchema;
    expect(Object.keys(contact.properties as object).sort()).toEqual(
      ["email", "id", "isPrimary", "name", "phone", "role"].sort(),
    );
  });
});
