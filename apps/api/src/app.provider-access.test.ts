import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { PROVIDER_ROUTE_RULES, PUBLIC_ROUTES } from "./lib/provider-access.js";

/**
 * Every route of the assembled app has a provider team rule
 * (lib/provider-access.ts) or is public. A new route without one would be
 * refused to every provider admin but an owner; this test names it instead,
 * so the rule is decided when the route is written.
 */
describe("provider team rules", () => {
  it("cover every registered route", () => {
    const app = buildApp();
    const missing = new Set<string>();
    for (const route of app.routes) {
      if (route.method === "ALL") {
        continue;
      }
      const key = `${route.method} ${route.path}`;
      if (!PUBLIC_ROUTES.has(key) && !PROVIDER_ROUTE_RULES[key]) {
        missing.add(key);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });
});
