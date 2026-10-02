// @vitest-environment happy-dom
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Info } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBackupJobRoutes } from "@/features/backup-jobs";
import { registerWebExtension, resetWebExtensionsForTesting } from "@/lib/extensions";

import { setActiveTenantId } from "@/lib/tenant";

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
const TENANT = "33333333-3333-4333-8333-333333333333";
const OTHER_TENANT = "44444444-4444-4444-8444-444444444444";
const SOURCE = "55555555-5555-4555-8555-555555555555";

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
  // The old run list's filter by queue is a tab of History now.
  ["/jobs?queue=verify", "/history", { type: "restore_check" }],
  ["/jobs?queue=retention&status=failed", "/history", { type: "maintenance", status: "failed" }],
  ["/jobs?queue=nonsense", "/history", {}],
  [`/jobs/${RUN}`, `/history/${RUN}`, {}],
  // A link with the drawer open keeps it.
  [`/jobs/${RUN}?run=${SOURCE}`, `/history/${RUN}`, { run: SOURCE }],
  ["/restore/jobs", "/restore", { tab: "recent" }],
  ["/reports", "/alerts", {}],
  ["/storage", `/tenants/${TENANT}/storage`, {}],
  ["/endpoints/agents", "/inventory", {}],
  ["/endpoints/servers", "/inventory", { kind: "server" }],
  ["/endpoints/clients", "/inventory", { kind: "client" }],
  [`/endpoints/servers/${MACHINE}`, `/inventory/${MACHINE}`, {}],
  [`/endpoints/clients/${MACHINE}?tab=snapshots`, `/inventory/${MACHINE}`, { tab: "snapshots" }],
  [`/endpoints/agents/${MACHINE}?tab=settings`, `/inventory/${MACHINE}`, { tab: "settings" }],
  // The settings page became the installation page (0.2.0): every tab leads to its section.
  ["/settings", "/installation/server", {}],
  ["/settings?section=general", "/installation/server", {}],
  ["/settings?section=mail", "/installation/mail", {}],
  ["/settings?section=microsoft365", "/installation/microsoft-app", {}],
  ["/settings?section=updates", "/installation/updates", {}],
  ["/settings?section=about", "/installation/about", {}],
  // The danger zone held one action, removing the mail configuration: it is part of the mail card now.
  ["/settings?section=danger", "/installation/mail", {}],
  // The opaque marker of a link into About (a locked menu entry's) travels along; nothing else does.
  ["/settings?section=about&requires=business", "/installation/about", { requires: "business" }],
  ["/settings?section=mail&requires=business", "/installation/mail", {}],
  ["/settings?section=billing", "/installation/server", {}],
  // The pages of one tenant became sections of its page (0.2.0): they lead to the tenant that is active.
  ["/sources", `/tenants/${TENANT}/connections`, {}],
  ["/sources/import", `/tenants/${TENANT}/connections/imports/new`, {}],
  [`/sources/${SOURCE}`, `/tenants/${TENANT}/connections/sources/${SOURCE}`, {}],
  ["/protected-objects", `/tenants/${TENANT}/protection`, {}],
  [
    "/protected-objects?q=anna&kind=mailbox",
    `/tenants/${TENANT}/protection`,
    { q: "anna", kind: "mailbox" },
  ],
  // The per-object backup became the mail jobs (the job definitions, 0.2.0).
  ["/backup", "/jobs", { type: "mail" }],
  ["/schedules", `/tenants/${TENANT}/jobs`, {}],
  ["/retention", `/tenants/${TENANT}/retention`, {}],
  ["/imports", `/tenants/${TENANT}/connections`, { tab: "imports" }],
  [`/imports/${RUN}`, `/tenants/${TENANT}/connections/imports/${RUN}`, {}],
  ["/members", `/tenants/${TENANT}/members`, {}],
  ["/repositories", `/tenants/${TENANT}/storage`, {}],
  ["/integrations", `/tenants/${TENANT}/integrations`, {}],
  ["/integrations?tab=webhooks", `/tenants/${TENANT}/integrations`, { tab: "webhooks" }],
  [`/integrations/webhooks/${RUN}`, `/tenants/${TENANT}/integrations/webhooks/${RUN}`, {}],
  // The consent callback names the tenant its link was made for: that one, not whichever is active.
  [
    `/sources/${SOURCE}?consent=granted&tenant=${OTHER_TENANT}&verified=ok`,
    `/tenants/${OTHER_TENANT}/connections/sources/${SOURCE}`,
    { consent: "granted", verified: "ok" },
  ],
  [
    "/sources?consent=invalid_state&reason=expired",
    `/tenants/${TENANT}/connections`,
    { consent: "invalid_state", reason: "expired" },
  ],
  // The provider keys' old place leads on to the tenant's own keys where the installation has no section for them.
  ["/integrations?tab=provider-keys", `/tenants/${TENANT}/integrations`, {}],
];

function split(url: string): [string, Record<string, unknown>] {
  const parsed = new URL(url, "https://restow.example.test");
  return [parsed.pathname, Object.fromEntries(parsed.searchParams)];
}

describe("legacyTarget", () => {
  for (const [old, path, search] of CASES) {
    it(`leads ${old} to ${path}`, () => {
      const [pathname, query] = split(old);
      expect(legacyTarget(pathname, query, [], TENANT)).toEqual({ to: path, search });
    });
  }

  it("leaves addresses alone that did not move", () => {
    for (const path of [
      "/",
      "/history",
      "/restore",
      `/restore/jobs/${RUN}`,
      // The job definitions: a job's own page is not the old address of a run.
      `/jobs/definitions/${RUN}`,
      // Live pages: the account page, the installation page, the tenant list and the tenant page itself.
      "/installation",
      "/installation/server",
      "/account",
      "/tenants",
      `/tenants/${TENANT}`,
      `/tenants/${TENANT}/connections`,
    ]) {
      expect(legacyTarget(path, {}, [], TENANT), path).toBeNull();
    }
  });

  it("sends a person without any tenant to the start page instead of a tenant page", () => {
    for (const path of ["/sources", "/schedules", "/members", "/repositories", "/integrations"]) {
      expect(legacyTarget(path, {}, [], null), path).toEqual({ to: "/", search: {} });
    }
  });

  it("leads the provider keys' old place to the installation's provider API where it exists", () => {
    expect(
      legacyTarget("/integrations", { tab: "provider-keys" }, [{ id: "provider-api" }], TENANT),
    ).toEqual({ to: "/installation/provider-api", search: {} });
  });
});

/** An extension that moves the license out of About, as the license module does. */
const LICENSE_SECTION = {
  id: "license",
  labelKey: "x:license",
  icon: Info,
  order: 80,
  component: () => null,
  legacySettingsSection: "about",
} as const;

describe("the license link of the old About tab", () => {
  it("leads to the section an extension claims About for, with its marker", () => {
    expect(legacyTarget("/settings", { section: "about" }, [LICENSE_SECTION])).toEqual({
      to: "/installation/license",
      search: {},
    });
    expect(
      legacyTarget("/settings", { section: "about", requires: "service_provider" }, [
        LICENSE_SECTION,
      ]),
    ).toEqual({ to: "/installation/license", search: { requires: "service_provider" } });
  });

  it("leaves the other tabs to the core", () => {
    expect(legacyTarget("/settings", { section: "updates" }, [LICENSE_SECTION])?.to).toBe(
      "/installation/updates",
    );
    expect(legacyTarget("/settings", {}, [LICENSE_SECTION])?.to).toBe("/installation/server");
  });
});

describe("legacy routes", () => {
  const root = createRootRoute();
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const routeTree = root.addChildren([
    ...createLegacyRoutes(() => root as unknown as AnyRoute),
    ...createBackupJobRoutes(() => root as unknown as AnyRoute),
    page("/"),
    page("/history"),
    page("/history/$jobId"),
    page("/restore"),
    page("/alerts"),
    page("/inventory"),
    page("/inventory/$endpointId"),
    page("/installation/$section"),
    page("/tenants/$tenantId/$section"),
    page("/tenants/$tenantId/connections/sources/$sourceId"),
    page("/tenants/$tenantId/connections/imports/new"),
    page("/tenants/$tenantId/connections/imports/$importId"),
    page("/tenants/$tenantId/protection/backup"),
    page("/tenants/$tenantId/integrations/webhooks/$webhookId"),
  ]);
  beforeEach(() => {
    setActiveTenantId(TENANT);
  });

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

  afterEach(() => {
    resetWebExtensionsForTesting();
  });

  it("sends the old license link to the license section when an extension adds one", async () => {
    registerWebExtension({ name: "license-test", installationSections: [LICENSE_SECTION] });
    const { location } = await land("/settings?section=about&requires=business");
    expect(location.pathname).toBe("/installation/license");
    expect(location.search).toEqual({ requires: "business" });
    // Without a section, About is still About.
    resetWebExtensionsForTesting();
    expect((await land("/settings?section=about")).location.pathname).toBe("/installation/about");
  });

  it("keeps the job definitions at /jobs?type=…, and only there", async () => {
    expect((await land("/jobs?type=mail")).location.pathname).toBe("/jobs");
    expect((await land("/jobs?type=endpoint")).location.pathname).toBe("/jobs");
    expect((await land("/jobs?type=other")).location.pathname).toBe("/history");
    // Without a kind it is the old run list, with its query.
    const bare = await land("/jobs?status=failed");
    expect(bare.location.pathname).toBe("/history");
    expect(bare.location.search).toEqual({ status: "failed" });
  });

  it("opens the editor address and a job's own page without leading them anywhere else", async () => {
    const editor = await land("/jobs?type=endpoint&new=1&select=m1,m2");
    expect(editor.location.pathname).toBe("/jobs");
    expect(editor.location.search).toEqual({ type: "endpoint", new: 1, select: "m1,m2" });
    const job = await land(`/jobs/definitions/${RUN}?type=mail&tab=scope`);
    expect(job.location.pathname).toBe(`/jobs/definitions/${RUN}`);
    expect(job.location.search).toEqual({ type: "mail", tab: "scope" });
  });
});
