import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProblemError, errorHandler, notFoundHandler } from "../../problem.js";
import { IntegrationApi, assertTenantUsable, hasLaterHandler } from "./api.js";
import { featuresOff, featuresOn } from "./testing/features.js";
import { OTHER_TENANT_ID, TENANT_ID, bearer, fakeRequireKey } from "./testing/keys.js";
import { type ScriptedDb, scriptedDb } from "./testing/scripted-db.js";

const tenantRow = (status: "active" | "suspended" | "deleting" = "active") => ({
  id: TENANT_ID,
  name: "Contoso",
  slug: "contoso",
  status,
  mailboxCap: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

function build(script: ScriptedDb, providerKeys = true) {
  const api = new IntegrationApi({
    db: script.db,
    requireKey: fakeRequireKey,
    requireFeature: providerKeys ? featuresOn : featuresOff,
  });
  api.tenant(
    {
      method: "get",
      path: "/probe",
      operationId: "probe",
      summary: "probe",
      tag: "Test",
      scope: "status:read",
      query: z.object({ limit: z.coerce.number().int().min(1).max(5).default(2) }),
      response: {
        status: 200,
        description: "ok",
        schema: z.object({ tenant: z.string(), limit: z.number() }),
      },
    },
    async ({ tenant, actor, input }) => ({
      tenant: `${tenant.slug}:${actor.label}`,
      limit: input.query.limit,
    }),
  );
  api.tenant(
    {
      method: "post",
      path: "/probe",
      operationId: "probeWrite",
      summary: "probe write",
      tag: "Test",
      scope: "restore:write",
      write: true,
      body: z.object({ full: z.boolean().default(false) }),
      response: { status: 202, description: "ok", schema: z.object({ full: z.boolean() }) },
    },
    async ({ input }) => ({ full: input.body.full }),
  );
  api.tenant(
    {
      method: "delete",
      path: "/probe/:id",
      operationId: "probeDelete",
      summary: "probe delete",
      tag: "Test",
      scope: "webhooks:manage",
      write: true,
      params: z.object({ id: z.string().uuid() }),
      response: { status: 204, description: "gone" },
    },
    async () => null,
  );
  api.provider(
    {
      method: "get",
      path: "/provider/probe",
      operationId: "providerProbe",
      summary: "provider probe",
      tag: "Test",
      scope: "status:read",
      response: { status: 200, description: "ok", schema: z.object({ key: z.string() }) },
    },
    async ({ key }) => ({ key: key.keyId }),
  );

  const app = new Hono();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.route("/api/v1", api.app);
  // A session-protected feature route on the same path, registered after the router.
  app.get("/api/v1/probe", (c) => c.json({ served: "feature" }));
  return { app, api };
}

describe("hasLaterHandler", () => {
  it("counts only method handlers after the current route, not middleware", () => {
    const routes = [{ method: "ALL" }, { method: "GET" }, { method: "ALL" }, { method: "GET" }];
    expect(hasLaterHandler(routes, 1)).toBe(true);
    expect(hasLaterHandler(routes, 3)).toBe(false);
    expect(hasLaterHandler([{ method: "GET" }, { method: "ALL" }], 0)).toBe(false);
  });
});

describe("assertTenantUsable", () => {
  it("lets everyone use an active tenant", () => {
    expect(() => assertTenantUsable("active", false, true)).not.toThrow();
  });

  it("refuses a suspended tenant's own key but lets a provider key read", () => {
    expect(() => assertTenantUsable("suspended", false, false)).toThrow(ProblemError);
    expect(() => assertTenantUsable("suspended", true, false)).not.toThrow();
  });

  it("refuses every change on a tenant that is not active", () => {
    try {
      assertTenantUsable("deleting", true, true);
      expect.unreachable();
    } catch (error) {
      expect((error as ProblemError).status).toBe(409);
    }
  });
});

describe("IntegrationApi", () => {
  it("passes requests without an API key on to the feature route of the same path", async () => {
    const { app } = build(scriptedDb([]));
    const res = await app.request("/api/v1/probe");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ served: "feature" });
  });

  it("asks for an API key when nothing else serves the path", async () => {
    const { app } = build(scriptedDb([]));
    const res = await app.request("/api/v1/provider/probe");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ type: "urn:restow:problem:api-key-required" });
  });

  it("resolves the key's tenant, validates the query and answers with the result", async () => {
    const script = scriptedDb([[tenantRow()]]);
    const { app } = build(script);
    const res = await app.request("/api/v1/probe?limit=4", {
      headers: bearer("rsk_tenant_status"),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: "contoso:api-key:key-status", limit: 4 });
    expect(script.pending()).toBe(0);
    expect(script.executed).toBe(1);
  });

  it("answers an invalid query with a 422 problem listing the issues", async () => {
    const { app } = build(scriptedDb([[tenantRow()]]));
    const res = await app.request("/api/v1/probe?limit=50", {
      headers: bearer("rsk_tenant_status"),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("enforces the scope before touching the database", async () => {
    const script = scriptedDb([]);
    const { app } = build(script);
    const res = await app.request("/api/v1/probe", {
      method: "POST",
      headers: bearer("rsk_tenant_status"),
    });
    expect(res.status).toBe(403);
    expect(script.executed).toBe(0);
  });

  it("refuses a tenant key that names another tenant", async () => {
    const { app } = build(scriptedDb([]));
    const res = await app.request("/api/v1/probe", {
      headers: { ...bearer("rsk_tenant_full"), "x-restow-tenant": OTHER_TENANT_ID },
    });
    expect(res.status).toBe(403);
  });

  it("makes a provider key name the tenant, and reports unknown tenants", async () => {
    const withoutHeader = await build(scriptedDb([])).app.request("/api/v1/probe", {
      headers: bearer("rsk_provider_full"),
    });
    expect(withoutHeader.status).toBe(400);

    const unknown = await build(scriptedDb([[]])).app.request("/api/v1/probe", {
      headers: { ...bearer("rsk_provider_full"), "x-restow-tenant": TENANT_ID },
    });
    expect(unknown.status).toBe(404);

    const known = await build(scriptedDb([[tenantRow()]])).app.request("/api/v1/probe", {
      headers: { ...bearer("rsk_provider_full"), "x-restow-tenant": TENANT_ID },
    });
    expect(known.status).toBe(200);
  });

  it("keeps a suspended tenant readable for the provider and closed to changes", async () => {
    const read = await build(scriptedDb([[tenantRow("suspended")]])).app.request("/api/v1/probe", {
      headers: { ...bearer("rsk_provider_full"), "x-restow-tenant": TENANT_ID },
    });
    expect(read.status).toBe(200);

    const ownKey = await build(scriptedDb([[tenantRow("suspended")]])).app.request(
      "/api/v1/probe",
      {
        headers: bearer("rsk_tenant_full"),
      },
    );
    expect(ownKey.status).toBe(403);

    const write = await build(scriptedDb([[tenantRow("suspended")]])).app.request("/api/v1/probe", {
      method: "POST",
      headers: { ...bearer("rsk_provider_full"), "x-restow-tenant": TENANT_ID },
    });
    expect(write.status).toBe(409);
  });

  it("treats an empty body as {} and a malformed one as a 400", async () => {
    const empty = await build(scriptedDb([[tenantRow()]])).app.request("/api/v1/probe", {
      method: "POST",
      headers: bearer("rsk_tenant_full"),
    });
    expect(empty.status).toBe(202);
    expect(await empty.json()).toEqual({ full: false });

    const malformed = await build(scriptedDb([[tenantRow()]])).app.request("/api/v1/probe", {
      method: "POST",
      headers: { ...bearer("rsk_tenant_full"), "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("answers 204 without a body", async () => {
    const res = await build(scriptedDb([[tenantRow()]])).app.request(
      `/api/v1/probe/${OTHER_TENANT_ID}`,
      { method: "DELETE", headers: bearer("rsk_tenant_full") },
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("keeps provider operations to provider keys while provider keys are on", async () => {
    const tenantKey = await build(scriptedDb([])).app.request("/api/v1/provider/probe", {
      headers: bearer("rsk_tenant_full"),
    });
    expect(tenantKey.status).toBe(403);

    const off = await build(scriptedDb([]), false).app.request("/api/v1/provider/probe", {
      headers: bearer("rsk_provider_full"),
    });
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ type: "urn:restow:problem:feature-unavailable" });

    const provider = await build(scriptedDb([])).app.request("/api/v1/provider/probe", {
      headers: bearer("rsk_provider_full"),
    });
    expect(await provider.json()).toEqual({ key: "key-provider" });
  });

  it("records every operation for the OpenAPI document", () => {
    const { api } = build(scriptedDb([]));
    expect(api.operations.map((operation) => [operation.operationId, operation.audience])).toEqual([
      ["probe", "tenant"],
      ["probeWrite", "tenant"],
      ["probeDelete", "tenant"],
      ["providerProbe", "provider"],
    ]);
  });
});
