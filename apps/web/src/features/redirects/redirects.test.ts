// @vitest-environment happy-dom
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { createSoonRoutes } from "@/features/soon";

import { createLegacyRoutes } from "./index";
import { legacyTarget } from "./targets";

/**
 * Every address that moved with the final menu (0.1.0) still opens the page,
 * with its query: links in mails, notifications, alerts, bookmarks and the
 * documentation keep working. One case per old address, first as data, then
 * through a real router.
 */

const RUN = "11111111-1111-4111-8111-111111111111";
const MACHINE = "22222222-2222-4222-8222-222222222222";

const CASES: readonly [old: string, path: string, search: Record<string, unknown>][] = [
  ["/stats", "/", { view: "statistics" }],
  ["/stats?period=90d", "/", { view: "statistics", period: "90d" }],
  [
    "/stats?period=custom&from=2026-09-01&to=2026-09-30&scope=provider",
    "/",
    {
      view: "statistics",
      period: "custom",
      from: "2026-09-01",
      to: "2026-09-30",
      scope: "provider",
    },
  ],
  ["/jobs", "/history", {}],
  [`/jobs/${RUN}`, `/history/${RUN}`, {}],
  ["/restore/jobs", "/restore", { tab: "recent" }],
  ["/reports", "/alerts", {}],
  ["/storage", "/repositories", {}],
  ["/endpoints/agents", "/inventory", {}],
  ["/endpoints/servers", "/inventory", { kind: "server" }],
  ["/endpoints/clients", "/inventory", { kind: "client" }],
  [`/endpoints/servers/${MACHINE}`, `/inventory/${MACHINE}`, {}],
  [`/endpoints/clients/${MACHINE}?tab=snapshots`, `/inventory/${MACHINE}`, { tab: "snapshots" }],
  [`/endpoints/agents/${MACHINE}?tab=settings`, `/inventory/${MACHINE}`, { tab: "settings" }],
];

function split(url: string): [string, Record<string, unknown>] {
  const parsed = new URL(url, "https://restow.example.test");
  return [parsed.pathname, Object.fromEntries(parsed.searchParams)];
}

describe("legacyTarget", () => {
  for (const [old, path, search] of CASES) {
    it(`leads ${old} to ${path}`, () => {
      const [pathname, query] = split(old);
      expect(legacyTarget(pathname, query)).toEqual({ to: path, search });
    });
  }

  it("leaves addresses alone that did not move", () => {
    for (const path of [
      "/",
      "/history",
      "/backup",
      "/sources",
      "/sources/abc",
      "/protected-objects",
      "/schedules",
      "/retention",
      "/imports",
      "/restore",
      `/restore/jobs/${RUN}`,
      "/settings",
      "/account",
      "/tenants",
    ]) {
      expect(legacyTarget(path, {}), path).toBeNull();
    }
  });
});

describe("legacy routes", () => {
  const root = createRootRoute();
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const routeTree = root.addChildren([
    ...createLegacyRoutes(() => root as unknown as AnyRoute),
    ...createSoonRoutes(() => root as unknown as AnyRoute),
    page("/"),
    page("/history"),
    page("/history/$jobId"),
    page("/restore"),
    page("/alerts"),
    page("/repositories"),
    page("/inventory"),
    page("/inventory/$endpointId"),
  ]);

  /** Where the history ends up after the router followed the redirects (no provider mounted). */
  async function land(url: string) {
    const history = createMemoryHistory({ initialEntries: [url] });
    const router = createRouter({ routeTree, history });
    // In a browser-like environment the router follows a redirect by
    // replacing the history entry (the server build only records it).
    await router.load();
    const search = router.options.parseSearch(history.location.search);
    return { location: { pathname: history.location.pathname, search }, length: history.length };
  }

  for (const [old, path, search] of CASES) {
    it(`redirects ${old} with its query, replacing the old entry`, async () => {
      const { location, length } = await land(old);
      expect(location.pathname).toBe(path);
      expect(location.search).toEqual(search);
      expect(length).toBe(1);
    });
  }

  it("keeps the job definitions' placeholder at /jobs?type=…, and only there", async () => {
    expect((await land("/jobs?type=mail")).location.pathname).toBe("/jobs");
    expect((await land("/jobs?type=endpoint")).location.pathname).toBe("/jobs");
    expect((await land("/jobs?type=other")).location.pathname).toBe("/history");
  });
});
