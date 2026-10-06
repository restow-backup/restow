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

  it("shows the default storage to every provider admin and lets administrators test it", () => {
    const view = "/api/v1/settings/default-storage";
    const test = "/api/v1/settings/default-storage/test";
    expect(decideProviderRoute(access("read_only"), "GET", view, {}).allowed).toBe(true);
    expect(decideProviderRoute(access("read_only"), "POST", test, {})).toMatchObject({
      allowed: false,
      required: "administrator",
    });
    expect(decideProviderRoute(access("technician"), "POST", test, {}).allowed).toBe(false);
    expect(decideProviderRoute(access("administrator"), "POST", test, {}).allowed).toBe(true);
    // It describes the installation: a member limited to some tenants has no business there.
    expect(decideProviderRoute(access("administrator", [TENANT_A]), "GET", view, {})).toEqual({
      allowed: false,
      reason: "scope",
    });
  });

  it("lets only the owner save or remove the default storage", () => {
    const path = "/api/v1/settings/default-storage";
    for (const method of ["PUT", "DELETE"] as const) {
      expect(decideProviderRoute(access("administrator"), method, path, {})).toMatchObject({
        allowed: false,
        required: "owner",
      });
      expect(decideProviderRoute(access("owner"), method, path, {}).allowed).toBe(true);
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

  it("lets every provider role look at backup jobs, a technician run one and an administrator change one", () => {
    const reader = access("read_only");
    const tech = access("technician");
    const admin = access("administrator");
    const list = ["GET", "/api/v1/backup-jobs"] as const;
    const one = ["GET", "/api/v1/backup-jobs/:id"] as const;
    const members = ["GET", "/api/v1/backup-jobs/:id/members"] as const;
    const run = ["POST", "/api/v1/backup-jobs/:id/run"] as const;
    const writes = [
      ["POST", "/api/v1/backup-jobs"],
      ["PATCH", "/api/v1/backup-jobs/:id"],
      ["DELETE", "/api/v1/backup-jobs/:id"],
      ["PUT", "/api/v1/backup-jobs/:id/members"],
      ["POST", "/api/v1/backup-jobs/:id/members"],
      ["PATCH", "/api/v1/backup-jobs/:id/members/:targetId"],
      ["DELETE", "/api/v1/backup-jobs/:id/members/:targetId"],
    ] as const;
    for (const [method, path] of [list, one, members]) {
      expect(decideProviderRoute(reader, method, path, {}).allowed, `${method} ${path}`).toBe(true);
    }
    // Looking is not running, and running is not changing.
    expect(decideProviderRoute(reader, ...run, {}).allowed).toBe(false);
    expect(decideProviderRoute(tech, ...run, {}).allowed).toBe(true);
    for (const [method, path] of writes) {
      expect(
        decideProviderRoute(reader, method, path, {}).allowed,
        `reader ${method} ${path}`,
      ).toBe(false);
      expect(
        decideProviderRoute(tech, method, path, {}).allowed,
        `technician ${method} ${path}`,
      ).toBe(false);
      expect(decideProviderRoute(admin, method, path, {}).allowed, `admin ${method} ${path}`).toBe(
        true,
      );
    }
    // The runs under their documented name follow the rules of /jobs.
    expect(decideProviderRoute(reader, "GET", "/api/v1/runs/:id", {}).allowed).toBe(true);
    expect(decideProviderRoute(reader, "POST", "/api/v1/runs/backup", {}).allowed).toBe(false);
    expect(decideProviderRoute(tech, "POST", "/api/v1/runs/backup", {}).allowed).toBe(true);
  });

  it("lets every provider role read History and the live channel, scoped to the tenant it enters", () => {
    const routes = [
      ["GET", "/api/v1/history"],
      ["GET", "/api/v1/history/:id"],
      ["GET", "/api/v1/live"],
    ] as const;
    for (const role of ["read_only", "technician", "administrator", "owner"] as const) {
      for (const [method, path] of routes) {
        // A team member limited to some tenants enters one through the tenant context, which checks it.
        expect(decideProviderRoute(access(role, [TENANT_A]), method, path, {}).allowed).toBe(true);
        expect(providerRouteRule(`${method} ${path}`)?.scope.kind).toBe("tenant");
      }
    }
    // Nothing of History writes: there is no rule for a write, so a non-owner is refused.
    expect(
      decideProviderRoute(access("administrator"), "POST", "/api/v1/history", {}).allowed,
    ).toBe(false);
  });

  it("shows the team to every provider admin with every tenant and lets only owners change it", () => {
    const changes = [
      ["POST", "/api/v1/provider-team"],
      ["PATCH", "/api/v1/provider-team/:userId"],
      ["DELETE", "/api/v1/provider-team/:userId"],
      ["POST", "/api/v1/provider-team/:userId/reissue"],
      ["POST", "/api/v1/provider-team/:userId/reset-access"],
    ] as const;
    for (const [method, path] of changes) {
      // The core's own table, not an extension's: the team is in every edition.
      expect(PROVIDER_ROUTE_RULES[`${method} ${path}`], path).toEqual({
        min: "owner",
        scope: { kind: "provider" },
      });
      for (const role of ["administrator", "technician", "read_only"] as const) {
        expect(decideProviderRoute(access(role), method, path, {})).toEqual({
          allowed: false,
          reason: "role",
          required: "owner",
        });
      }
      expect(decideProviderRoute(access("owner"), method, path, {}).allowed).toBe(true);
    }
    expect(decideProviderRoute(access("read_only"), "GET", "/api/v1/provider-team", {})).toEqual({
      allowed: true,
    });
    expect(
      decideProviderRoute(access("administrator", [TENANT_A]), "GET", "/api/v1/provider-team", {}),
    ).toEqual({ allowed: false, reason: "scope" });
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
