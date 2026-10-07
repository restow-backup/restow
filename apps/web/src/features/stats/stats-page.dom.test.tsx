// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardPage } from "@/features/dashboard/dashboard-page";
import {
  type Mounted,
  enableActEnvironment,
  flush,
  json,
  mount,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import type { SessionContextValue, SessionTenant } from "@/lib/session";
import { setActiveTenantId } from "@/lib/tenant";

import { AllTenantsStatsPage } from "./stats-page";

/**
 * The two statistics pages. Overview › Statistics is the active tenant's alone:
 * it asks for the tenant scope with that tenant's header whatever the address
 * says (a stale `scope=provider` included), names the tenant and has no scope
 * toggle; provider admins who may see every tenant get a link to the page of
 * all tenants. That page asks for the provider scope, explains itself to whoever
 * may not see it, and a row of its tenants table opens that tenant's statistics.
 */

enableActEnvironment();

const router = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      activeOptions: _activeOptions,
      ...props
    }: {
      to: string;
      search?: Record<string, string>;
      activeOptions?: unknown;
      children: React.ReactNode;
    }) => {
      const query = new URLSearchParams(search ?? {}).toString();
      return (
        <a href={query ? `${to}?${query}` : to} {...props}>
          {children}
        </a>
      );
    },
    useSearch: () => router.search,
    useNavigate: () => router.navigate,
    useRouter: () => ({ options: { context: { navItems: [] } } }),
    useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
      select({ location: { pathname: "/", search: router.search } }),
  };
});

const tenant = (id: string, name: string, over: Partial<SessionTenant> = {}): SessionTenant => ({
  id,
  name,
  slug: id,
  kind: "customer",
  customerNumber: null,
  role: "tenant_admin",
  status: "active",
  ...over,
});

const MUELLER = tenant("mueller", "Müller GmbH");
const NORD = tenant("nord", "Nordlicht AG");

interface Seen {
  url: string;
  tenant: string | null;
}

const requests: Seen[] = [];
let mounted: Mounted | null = null;

function statsPayload(scope: "tenant" | "provider") {
  return {
    period: { from: "2026-09-01", to: "2026-09-30", granularity: "day", days: 30 },
    previous: { from: "2026-08-02", to: "2026-08-31" },
    scope,
    generatedAt: new Date().toISOString(),
    kpis: {},
    series: {},
    tables: {
      failuresByCause: [],
      largestObjects: [],
      ...(scope === "provider"
        ? {
            tenants: [
              {
                id: "nord",
                name: "Nordlicht AG",
                objects: 3,
                successRate: 1,
                logicalBytes: 100,
                physicalBytes: 50,
                readiness: "green",
                failures: 0,
              },
            ],
          }
        : {}),
    },
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  requests.length = 0;
  router.search = {};
  router.navigate.mockReset();
  setActiveTenantId("mueller");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, tenant: new Headers(init?.headers).get("X-Restow-Tenant") });
    return json(statsPayload(url.includes("scope=provider") ? "provider" : "tenant"));
  });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const statsRequests = () => requests.filter((request) => request.url.includes("/stats"));
const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ");

const PROVIDER_WITH_EVERYTHING: Partial<SessionContextValue> = {
  role: "provider_admin",
  isProviderAdmin: true,
  providerAllTenants: true,
  activeTenant: MUELLER,
  tenants: [MUELLER, NORD],
  features: ["tenants.additional", "stats.allTenants", "dashboard.allTenants"],
  scope: "tenant",
};

async function open(node: React.ReactNode, session: Partial<SessionContextValue>) {
  mounted = mount(node, { session: sessionAs(session) });
  await flush(8);
  return mounted.container;
}

describe("Overview › Statistics", () => {
  it("shows the active tenant alone, names it and offers no scope toggle", async () => {
    router.search = { view: "statistics" };
    const page = await open(<DashboardPage />, PROVIDER_WITH_EVERYTHING);
    expect(statsRequests()).toHaveLength(1);
    expect(statsRequests()[0]?.url).not.toContain("scope=");
    expect(statsRequests()[0]?.tenant).toBe("mueller");
    expect(text(page)).toContain("Müller GmbH only");
    expect(page.querySelector('[aria-label="Scope"]')).toBeNull();
    expect(page.querySelector('[data-slot="stats-tenants"]')).toBeNull();
    expect(text(page)).not.toContain("Tenants");
  });

  it("ignores a stale scope=provider in the address", async () => {
    router.search = { view: "statistics", scope: "provider", period: "7d" };
    const page = await open(<DashboardPage />, PROVIDER_WITH_EVERYTHING);
    expect(statsRequests()).toHaveLength(1);
    expect(statsRequests()[0]?.url).not.toContain("scope=provider");
    expect(statsRequests()[0]?.tenant).toBe("mueller");
    expect(text(page)).toContain("Müller GmbH only");
  });

  it("links to the statistics of all tenants with the same period, for who may see them", async () => {
    router.search = { view: "statistics", period: "90d" };
    const page = await open(<DashboardPage />, PROVIDER_WITH_EVERYTHING);
    const link = page.querySelector('[data-slot="stats-all-tenants"]');
    expect(link?.getAttribute("href")).toBe("/statistics/all?period=90d");
    expect(text(link as Element)).toBe("Compare all tenants");
  });

  it("offers no such link where the viewer may not see every tenant", async () => {
    router.search = { view: "statistics" };
    for (const session of [
      // A member of the provider team limited to some tenants.
      { ...PROVIDER_WITH_EVERYTHING, providerAllTenants: false },
      // An installation without the feature (Community, Business).
      { ...PROVIDER_WITH_EVERYTHING, features: [] },
      // A tenant's own administrator.
      {
        ...PROVIDER_WITH_EVERYTHING,
        role: "tenant_admin" as const,
        isProviderAdmin: false,
        providerAllTenants: false,
      },
    ]) {
      const page = await open(<DashboardPage />, session);
      expect(page.querySelector('[data-slot="stats-all-tenants"]')).toBeNull();
      expect(statsRequests().every((request) => !request.url.includes("scope="))).toBe(true);
      await mounted?.unmount();
      mounted = null;
    }
  });
});

describe("the statistics of all tenants", () => {
  it("asks for every tenant and names its page", async () => {
    const page = await open(<AllTenantsStatsPage />, PROVIDER_WITH_EVERYTHING);
    expect(statsRequests()).toHaveLength(1);
    expect(statsRequests()[0]?.url).toContain("scope=provider");
    expect(text(page)).toContain("Statistics of all tenants");
    expect(text(page)).toContain("across all tenants");
    expect(text(page)).toContain("Nordlicht AG");
    expect(page.querySelector('[data-slot="stats-all-tenants"]')).toBeNull();
  });

  it("opens a tenant's own statistics from its row, for the same period", async () => {
    router.search = { period: "7d" };
    const setActiveTenant = vi.fn();
    const page = await open(<AllTenantsStatsPage />, {
      ...PROVIDER_WITH_EVERYTHING,
      setActiveTenant,
    });
    const cell = page.querySelector("tbody tr td");
    await act(async () => {
      cell?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      );
    });
    await act(async () => {
      document.querySelector<HTMLElement>('[data-action="stats"]')?.click();
    });
    expect(setActiveTenant).toHaveBeenCalledWith("nord");
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { period: "7d", view: "statistics" },
    });
  });

  it("explains itself and leads to Overview › Statistics where it is not offered", async () => {
    router.search = { period: "12m" };
    for (const session of [
      { ...PROVIDER_WITH_EVERYTHING, providerAllTenants: false },
      { ...PROVIDER_WITH_EVERYTHING, features: [] },
      {
        ...PROVIDER_WITH_EVERYTHING,
        role: "tenant_admin" as const,
        isProviderAdmin: false,
        providerAllTenants: false,
      },
    ]) {
      const page = await open(<AllTenantsStatsPage />, session);
      expect(statsRequests()).toHaveLength(0);
      expect(page.querySelector('[data-slot="stats-provider-unavailable"]')).not.toBeNull();
      const link = [...page.querySelectorAll("a")].find(
        (anchor) => anchor.textContent === "Open the statistics in Overview",
      );
      expect(link?.getAttribute("href")).toBe("/?period=12m&view=statistics");
      await mounted?.unmount();
      mounted = null;
    }
  });
});
