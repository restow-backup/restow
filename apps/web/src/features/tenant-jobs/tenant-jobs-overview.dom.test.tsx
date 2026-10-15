import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import type { NavItem } from "@/lib/navigation";
import { type SessionContextValue, type SessionTenant, StaticSessionProvider } from "@/lib/session";

import type { TenantJobKindSummary, TenantJobList, TenantJobSummaries } from "./api.js";
import { TenantJobsOverview } from "./tenant-jobs-overview.js";

/**
 * The "All tenants" view of Jobs in a real DOM (#63): a row per tenant with its jobs counted,
 * what runs, how the newest backups ended; a row opens in place (aria-expanded, the region it
 * controls) and loads that tenant's jobs only then; "Switch to tenant" makes the tenant the
 * active one without opening the row.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tenant(id: string, name: string, extra: Partial<SessionTenant> = {}): SessionTenant {
  return {
    id,
    name,
    slug: id,
    kind: "customer",
    customerNumber: null,
    role: "tenant_admin",
    status: "active",
    ...extra,
  };
}

const OWN = tenant("own", "Own GmbH", { kind: "internal" });
const ALPHA = tenant("alpha", "Alpha AG", { customerNumber: "KD-1" });
const BETA = tenant("beta", "Beta KG");
const BROKEN = tenant("broken", "Broken Ltd");

const NONE: TenantJobKindSummary = {
  jobs: 0,
  paused: 0,
  running: 0,
  queued: 0,
  outcome: null,
  failed: 0,
  warning: 0,
  lastRunAt: null,
  nextRunAt: null,
};

const SUMMARIES: TenantJobSummaries = {
  generatedAt: "2026-10-15T10:00:00Z",
  tenants: [
    {
      tenantId: "own",
      name: OWN.name,
      status: "active",
      kind: "internal",
      state: "ok",
      kinds: { mail: NONE, endpoint: NONE, pve: NONE },
    },
    {
      tenantId: "alpha",
      name: ALPHA.name,
      status: "active",
      kind: "customer",
      state: "ok",
      kinds: {
        mail: {
          ...NONE,
          jobs: 2,
          running: 1,
          outcome: "failed",
          failed: 1,
          lastRunAt: "2026-10-15T08:00:00Z",
          nextRunAt: "2026-10-15T22:00:00Z",
        },
        endpoint: { ...NONE, jobs: 1, queued: 1, outcome: "succeeded" },
        pve: { ...NONE, jobs: 1, outcome: "warning", warning: 1 },
      },
    },
    {
      tenantId: "beta",
      name: BETA.name,
      status: "active",
      kind: "customer",
      state: "ok",
      kinds: { mail: { ...NONE, jobs: 1, paused: 1 }, endpoint: NONE, pve: NONE },
    },
    {
      tenantId: "broken",
      name: BROKEN.name,
      status: "active",
      kind: "customer",
      state: "error",
      kinds: null,
    },
  ],
};

const ALPHA_JOBS: TenantJobList = {
  tenantId: "alpha",
  items: [
    {
      id: "j1",
      kind: "mail",
      name: "All mailboxes",
      enabled: true,
      scopeMode: "all",
      scopeCount: 12,
      schedule: { kind: "interval", intervalMinutes: 240, timeZone: "UTC" },
      lastRun: { at: "2026-10-15T08:00:00Z", failed: 1, partial: 0, running: 1, queued: 0 },
      nextRunAt: "2026-10-15T22:00:00Z",
      state: "failing",
    },
    {
      id: "j2",
      kind: "pve",
      name: "Every guest",
      enabled: true,
      scopeMode: "all",
      scopeCount: 3,
      schedule: null,
      lastRun: { at: null, failed: 0, partial: 0, running: 0, queued: 0 },
      nextRunAt: null,
      state: "manual",
    },
  ],
};

const setActiveTenant = vi.fn();
const requests: string[] = [];

function session(): SessionContextValue {
  return {
    status: "authenticated",
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role: "provider_admin",
    features: ["tenants.additional"],
    extensions: {},
    isProviderAdmin: true,
    tenants: [OWN, ALPHA, BETA, BROKEN],
    activeTenant: OWN,
    setActiveTenant,
    scope: "all",
    canViewAllTenants: true,
    setScopeAll: vi.fn(),
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
  } as SessionContextValue;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  setActiveTenant.mockReset();
  requests.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const body = url.endsWith("/tenant-jobs") ? SUMMARIES : ALPHA_JOBS;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function render() {
  const rootRoute = createRootRouteWithContext<{ navItems: readonly NavItem[] }>()({
    component: () => <TenantJobsOverview title="Jobs" area="mail" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/jobs?type=mail"] }),
    context: { navItems: [] },
  });
  await router.load();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <StaticSessionProvider value={session()}>
            <RouterProvider router={router} />
          </StaticSessionProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await tick();
  });
  await act(async () => {
    await tick();
  });
}

const rowOf = (id: string) => document.querySelector<HTMLElement>(`li[data-tenant="${id}"]`);
const toggleOf = (id: string) =>
  rowOf(id)?.querySelector<HTMLButtonElement>('[data-slot="all-tenants-toggle"]') ?? null;
const panelOf = (id: string) =>
  rowOf(id)?.querySelector<HTMLElement>('[data-slot="all-tenants-detail"]') ?? null;
const summaryOf = (id: string) =>
  rowOf(id)?.querySelector<HTMLElement>('[data-slot="all-tenants-summary"]')?.textContent ?? "";

describe("Jobs under All tenants", () => {
  it("lists every tenant with its jobs counted, running work, the outcome and the next run", async () => {
    await render();
    expect(requests.filter((url) => url.endsWith("/tenant-jobs"))).toHaveLength(1);
    expect(
      [...document.querySelectorAll("li[data-tenant]")].map((li) => li.getAttribute("data-tenant")),
    ).toEqual(["own", "alpha", "beta", "broken"]);

    const alpha = summaryOf("alpha");
    expect(alpha).toContain("2 mail jobs · 1 machine job · 1 Proxmox VE job");
    expect(alpha).toContain("1 backup running");
    expect(alpha).toContain("1 waiting");
    expect(alpha).toContain("Last backup failed");
    expect(alpha).toContain("Next run:");
    expect(
      rowOf("alpha")?.querySelector('[data-slot="tenant-activity"] svg')?.getAttribute("class"),
    ).toContain("motion-safe:animate-spin");

    expect(summaryOf("own")).toBe("No jobs");
    expect(summaryOf("beta")).toContain("1 mail job · 1 paused");
    expect(summaryOf("beta")).toContain("No backup yet");
    expect(summaryOf("beta")).toContain("Nothing planned");
    expect(summaryOf("broken")).toContain("Figures unavailable");
    // Only the tenants on offer are fetched: no tenant's job list for the overview.
    expect(requests.some((url) => /\/tenant-jobs\/./.test(url))).toBe(false);
  });

  it("opens a row in place, loading only that tenant's jobs, and closes it again", async () => {
    await render();
    const toggle = toggleOf("alpha");
    const panel = panelOf("alpha");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.hidden).toBe(true);
    // The summary is the toggle's description for a screen reader.
    const described = toggle?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toContain("Last backup failed");

    await act(async () => {
      toggle?.click();
      await tick();
    });
    await act(async () => {
      await tick();
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.hidden).toBe(false);
    expect(requests.filter((url) => url.endsWith("/tenant-jobs/alpha"))).toHaveLength(1);
    const jobs = [...(panel?.querySelectorAll<HTMLElement>("li[data-job]") ?? [])];
    expect(jobs.map((li) => li.getAttribute("data-kind"))).toEqual(["mail", "pve"]);
    expect(jobs[0]?.textContent).toContain("All mailboxes");
    expect(jobs[0]?.textContent).toContain("All (12)");
    expect(jobs[0]?.textContent).toContain("Backup failed");
    expect(jobs[1]?.textContent).toContain("Manual only");
    expect(panel?.textContent).toContain("Read only.");
    expect(setActiveTenant).not.toHaveBeenCalled();

    await act(async () => {
      toggle?.click();
      await tick();
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hidden).toBe(true);
  });

  it("switches to a tenant from its row without opening it", async () => {
    await render();
    const button = rowOf("beta")?.querySelector<HTMLButtonElement>(
      '[data-slot="all-tenants-switch"]',
    );
    expect(button?.getAttribute("aria-label")).toBe("Switch to Beta KG and open this page there");
    await act(async () => {
      button?.click();
      await tick();
    });
    expect(setActiveTenant).toHaveBeenCalledWith("beta");
    expect(toggleOf("beta")?.getAttribute("aria-expanded")).toBe("false");
  });
});
