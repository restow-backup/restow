// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { dashboardRoute } from "./index.js";

/**
 * Overview › Statistics is the active tenant's alone (0.3.0). An old link to
 * the totals of every tenant, `/?view=statistics&scope=provider`, leads to
 * their own page with its period and replaces the old history entry; every
 * other address of the overview stays, and never keeps a scope.
 */

const validate = dashboardRoute.options.validateSearch as (
  raw: Record<string, unknown>,
) => Record<string, unknown>;

async function land(url: string) {
  const root = createRootRoute();
  const overview = createRoute({
    getParentRoute: () => root,
    path: "/",
    validateSearch: (search: Record<string, unknown>) => validate(search),
    beforeLoad: (context) => (dashboardRoute.options.beforeLoad as (c: unknown) => void)(context),
    component: () => null,
  });
  const allTenants = createRoute({
    getParentRoute: () => root,
    path: "/statistics/all",
    component: () => null,
  });
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createRouter({ routeTree: root.addChildren([overview, allTenants]), history });
  await router.load();
  return {
    pathname: history.location.pathname,
    search: router.options.parseSearch(history.location.search),
    length: history.length,
  };
}

describe("the overview's address", () => {
  it("leads an old link to the statistics of all tenants to their page, with the period", async () => {
    const landed = await land(
      "/?view=statistics&scope=provider&period=custom&from=2026-09-01&to=2026-09-30",
    );
    expect(landed.pathname).toBe("/statistics/all");
    expect(landed.search).toEqual({ period: "custom", from: "2026-09-01", to: "2026-09-30" });
    expect(landed.length).toBe(1);
  });

  it("keeps Overview › Statistics on the overview, without any scope", async () => {
    for (const url of ["/?view=statistics", "/?view=statistics&scope=tenant&period=7d"]) {
      expect((await land(url)).pathname, url).toBe("/");
    }
    expect(validate({ view: "statistics", scope: "provider", period: "7d" })).toEqual({
      view: "statistics",
      period: "7d",
    });
  });

  it("leaves the Status tab alone, whatever stray scope it carries", async () => {
    const landed = await land("/?scope=provider");
    expect(landed.pathname).toBe("/");
  });
});
