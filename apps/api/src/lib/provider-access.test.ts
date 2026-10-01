import { Hono } from "hono";
import { routePath } from "hono/route";
import { afterEach, describe, expect, it } from "vitest";
import { registerApiExtension, resetExtensionsForTesting } from "../extensions.js";
import {
  OWNER_ACCESS,
  PROVIDER_ROUTE_RULES,
  type ProviderAccess,
  decideProviderRoute,
  providerMayEnterTenant,
  providerRoleSatisfies,
  providerRouteRule,
  providerRule,
} from "./provider-access.js";

afterEach(() => {
  resetExtensionsForTesting();
});

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

const access = (role: ProviderAccess["role"], tenants?: string[]): ProviderAccess => ({
  role,
  allTenants: tenants === undefined,
  tenantIds: new Set(tenants ?? []),
});

describe("provider roles", () => {
  it("rank owner > administrator > technician > read_only", () => {
    expect(providerRoleSatisfies("owner", "administrator")).toBe(true);
    expect(providerRoleSatisfies("administrator", "technician")).toBe(true);
    expect(providerRoleSatisfies("technician", "read_only")).toBe(true);
    expect(providerRoleSatisfies("read_only", "technician")).toBe(false);
    expect(providerRoleSatisfies("technician", "administrator")).toBe(false);
    expect(providerRoleSatisfies("administrator", "owner")).toBe(false);
  });
});

describe("decideProviderRoute", () => {
  it("lets an owner with every tenant through, even on a route without a rule", () => {
    expect(decideProviderRoute(OWNER_ACCESS, "POST", "/api/v1/whatever", {})).toEqual({
      allowed: true,
    });
  });

  it("refuses a route without a rule to everyone but an owner (fail closed)", () => {
    expect(
      decideProviderRoute(access("administrator"), "POST", "/api/v1/unknown", {}),
    ).toMatchObject({
      allowed: false,
      reason: "role",
      required: "owner",
    });
  });

  it("keeps installation settings, provider keys and deleting tenants to owners", () => {
    for (const [method, path] of [
      ["PATCH", "/api/v1/settings"],
      ["PUT", "/api/v1/settings/microsoft-app"],
      ["POST", "/api/v1/api-keys/provider"],
      ["DELETE", "/api/v1/tenants/:id"],
    ] as const) {
      expect(
        decideProviderRoute(access("administrator"), method, path, { id: TENANT_A }),
      ).toMatchObject({
        allowed: false,
        required: "owner",
      });
    }
  });

  it("lets a technician operate but not configure", () => {
    const tech = access("technician");
    expect(decideProviderRoute(tech, "POST", "/api/v1/jobs/backup", {}).allowed).toBe(true);
    expect(decideProviderRoute(tech, "POST", "/api/v1/restore", {}).allowed).toBe(true);
    expect(decideProviderRoute(tech, "GET", "/api/v1/archive/search", {}).allowed).toBe(true);
    expect(decideProviderRoute(tech, "POST", "/api/v1/sources", {}).allowed).toBe(false);
    expect(decideProviderRoute(tech, "PATCH", "/api/v1/schedules/:id", {}).allowed).toBe(false);
    expect(decideProviderRoute(tech, "POST", "/api/v1/tenants", {}).allowed).toBe(false);
  });

  it("applies the rules an extension contributes for its own routes", () => {
    const path = "/api/v1/example/secret";
    expect(providerRouteRule(`GET ${path}`)).toBeNull();
    registerApiExtension({
      name: "example",
      providerRouteRules: { [`GET ${path}`]: providerRule.configure() },
    });
    expect(providerRouteRule(`GET ${path}`)).toEqual({
      min: "administrator",
      scope: { kind: "tenant" },
    });
    expect(decideProviderRoute(access("technician"), "GET", path, {})).toEqual({
      allowed: false,
      reason: "role",
      required: "administrator",
    });
    expect(decideProviderRoute(access("administrator"), "GET", path, {}).allowed).toBe(true);
  });

  it("lets read-only members see status but no content and change nothing", () => {
    const ro = access("read_only");
    expect(decideProviderRoute(ro, "GET", "/api/v1/dashboard", {}).allowed).toBe(true);
    expect(decideProviderRoute(ro, "GET", "/api/v1/usage", {}).allowed).toBe(true);
    expect(decideProviderRoute(ro, "HEAD", "/api/v1/jobs", {}).allowed).toBe(true);
    for (const path of [
      "/api/v1/snapshots/:id/tree",
      "/api/v1/snapshots/search",
      "/api/v1/snapshots/:snapshotId/entries/:entryId/preview",
      "/api/v1/restore/:id/download",
      "/api/v1/exports/:id/download",
      "/api/v1/archive/search",
      "/api/v1/archive/items/:id",
    ]) {
      expect(decideProviderRoute(ro, "GET", path, {}).allowed).toBe(false);
    }
    expect(decideProviderRoute(ro, "POST", "/api/v1/jobs/backup", {}).allowed).toBe(false);
  });

  it("keeps a member limited to some tenants off provider-wide routes and foreign tenants", () => {
    const scoped = access("administrator", [TENANT_A]);
    expect(decideProviderRoute(scoped, "GET", "/api/v1/tenants", {}).allowed).toBe(true);
    expect(
      decideProviderRoute(scoped, "GET", "/api/v1/tenants/:id", { id: TENANT_A }).allowed,
    ).toBe(true);
    expect(decideProviderRoute(scoped, "GET", "/api/v1/tenants/:id", { id: TENANT_B })).toEqual({
      allowed: false,
      reason: "scope",
    });
    expect(decideProviderRoute(scoped, "POST", "/api/v1/tenants", {})).toEqual({
      allowed: false,
      reason: "scope",
    });
    expect(decideProviderRoute(scoped, "GET", "/api/v1/usage", {})).toEqual({
      allowed: false,
      reason: "scope",
    });
    expect(decideProviderRoute(scoped, "GET", "/api/v1/settings", {})).toEqual({
      allowed: false,
      reason: "scope",
    });
    // Tenant routes pass here; the tenant context checks the tenant itself.
    expect(decideProviderRoute(scoped, "GET", "/api/v1/jobs", {}).allowed).toBe(true);
  });

  it("scopes tenant entry", () => {
    expect(providerMayEnterTenant(access("technician", [TENANT_A]), TENANT_A)).toBe(true);
    expect(providerMayEnterTenant(access("technician", [TENANT_A]), TENANT_B)).toBe(false);
    expect(providerMayEnterTenant(access("technician"), TENANT_B)).toBe(true);
  });

  it("classifies every rule with a known role and a scope", () => {
    for (const [key, rule] of Object.entries(PROVIDER_ROUTE_RULES)) {
      expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\//);
      expect(["owner", "administrator", "technician", "read_only"]).toContain(rule.min);
    }
  });
});

describe("the route a middleware sees", () => {
  it("is the handler's own pattern, also for a router-wide use('*')", async () => {
    const seen: string[] = [];
    const sub = new Hono();
    sub.use("*", async (c, next) => {
      seen.push(routePath(c, -1));
      await next();
    });
    sub.get("/items/:id", (c) => c.text("ok"));
    const app = new Hono();
    app.route("/api/v1/things", sub);
    const response = await app.request("/api/v1/things/items/42");
    expect(response.status).toBe(200);
    expect(seen).toEqual(["/api/v1/things/items/:id"]);
  });
});
