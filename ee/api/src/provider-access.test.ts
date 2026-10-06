import { afterAll, describe, expect, it } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../apps/api/src/extensions.js";
import {
  PROVIDER_ROUTE_RULES,
  PUBLIC_ROUTES,
  type ProviderAccess,
  decideProviderRoute,
  providerRouteRule,
} from "../../../apps/api/src/lib/provider-access.js";
import { eeApiExtension } from "./index.js";
import { eeProviderRouteRules } from "./provider-rules.js";

/**
 * The provider team's rules (apps/api/src/lib/provider-access.ts) must cover
 * the routes of the Business and Service Provider modules too; ee/ contributes
 * them (./provider-rules.ts). The core's own test
 * (apps/api/src/app.provider-access.test.ts) builds the app without `ee/`, so
 * a route registered here would slip through it: a provider administrator,
 * technician or read-only member would be refused (403, the fail-closed
 * fallback is owner only) without anyone noticing.
 */

registerApiExtension(eeApiExtension);

afterAll(() => {
  resetExtensionsForTesting();
});

const { buildApp } = await import("../../../apps/api/src/app.js");

/** Every `METHOD /path` the assembled app (core and `ee/`) registers. */
function registeredRoutes(): Set<string> {
  const keys = new Set<string>();
  for (const route of buildApp().routes) {
    if (route.method !== "ALL") {
      keys.add(`${route.method} ${route.path}`);
    }
  }
  return keys;
}

describe("provider team rules of the assembled app, with ee/", () => {
  it("has the ee routes registered at all", () => {
    const routes = registeredRoutes();
    expect(routes.has("GET /api/v1/archive/journal")).toBe(true);
    expect(routes.has("GET /api/v1/license")).toBe(true);
    // The provider team is the core's (every edition); ee/ adds no rule for it.
    expect(routes.has("GET /api/v1/provider-team")).toBe(true);
    expect(
      Object.keys(eeProviderRouteRules).filter((key) => key.includes("/provider-team")),
    ).toEqual([]);
  });

  it("covers every registered route with a rule or the public list", () => {
    const missing = [...registeredRoutes()]
      .filter((key) => !PUBLIC_ROUTES.has(key) && !providerRouteRule(key))
      .sort();
    expect(missing).toEqual([]);
  });

  it("keeps no rule for a route that is not registered", () => {
    const routes = registeredRoutes();
    const stale = [...Object.keys(PROVIDER_ROUTE_RULES), ...Object.keys(eeProviderRouteRules)]
      .filter((key) => !routes.has(key))
      .sort();
    expect(stale).toEqual([]);
  });
});

const access = (role: ProviderAccess["role"], tenants?: string[]): ProviderAccess => ({
  role,
  allTenants: tenants === undefined,
  tenantIds: new Set(tenants ?? []),
});
const TENANT_A = "11111111-1111-4111-8111-111111111111";

describe("the rules of the ee/ routes", () => {
  it("keeps the team and the license key to owners", () => {
    for (const [method, path] of [
      ["POST", "/api/v1/provider-team"],
      ["DELETE", "/api/v1/provider-team/:userId"],
      ["POST", "/api/v1/license"],
      ["DELETE", "/api/v1/license"],
    ] as const) {
      expect(decideProviderRoute(access("administrator"), method, path, {})).toMatchObject({
        allowed: false,
        required: "owner",
      });
    }
  });

  it("keeps the journal address, a credential, to administrators and owners", () => {
    for (const [method, path] of [
      ["GET", "/api/v1/archive/journal"],
      ["POST", "/api/v1/archive/journal/rotate"],
    ] as const) {
      expect(eeProviderRouteRules[`${method} ${path}`]).toEqual({
        min: "administrator",
        scope: { kind: "tenant" },
      });
      for (const role of ["technician", "read_only"] as const) {
        expect(decideProviderRoute(access(role), method, path, {})).toEqual({
          allowed: false,
          reason: "role",
          required: "administrator",
        });
      }
      expect(decideProviderRoute(access("administrator"), method, path, {}).allowed).toBe(true);
      expect(
        decideProviderRoute(access("administrator", [TENANT_A]), method, path, {}).allowed,
      ).toBe(true);
    }
  });

  it("lets read-only members read the audit log and the license, and place no hold", () => {
    const ro = access("read_only");
    expect(decideProviderRoute(ro, "GET", "/api/v1/audit", {}).allowed).toBe(true);
    expect(decideProviderRoute(ro, "GET", "/api/v1/license", {}).allowed).toBe(true);
    expect(
      decideProviderRoute(access("technician"), "POST", "/api/v1/archive/legal-holds", {}).allowed,
    ).toBe(false);
  });

  it("keeps a member limited to some tenants off the license and the team", () => {
    const scoped = access("administrator", [TENANT_A]);
    for (const path of ["/api/v1/license", "/api/v1/provider-team"]) {
      expect(decideProviderRoute(scoped, "GET", path, {})).toEqual({
        allowed: false,
        reason: "scope",
      });
    }
  });
});
