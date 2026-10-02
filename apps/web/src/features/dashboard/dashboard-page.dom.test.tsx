// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  enableActEnvironment,
  flush,
  json,
  mount,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { registerWebExtension, resetWebExtensionsForTesting } from "@/lib/extensions";
import type { SlotProps } from "@/lib/extensions";
import type { SessionTenant } from "@/lib/session";

import type { Dashboard } from "./api";
import { DashboardPage } from "./dashboard-page";

/**
 * The overview follows the tenant switcher: a tenant shows only that tenant, "All
 * tenants" the provider view alone. The tabs "Provider" and "Tenant" are gone,
 * and so is the setup card, whatever its state.
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
      ...props
    }: { to: string; search?: Record<string, string>; children: React.ReactNode }) => {
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

const OWN = tenant("own", "Own organisation", { kind: "internal" });
const MUELLER = tenant("mueller", "Müller GmbH");

const READINESS = { green: 3, yellow: 0, red: 2, unverified: 1, noBackup: 0 };

function tenantDashboard(): Dashboard {
  return {
    generatedAt: new Date().toISOString(),
    viewer: { role: "provider_admin", isProviderAdmin: true, canAdminister: true },
    tenant: { id: "mueller", name: "Müller GmbH", slug: "mueller", status: "active" },
    widgets: {
      // The server still sends the checklist; the page has no card for it.
      setup: {
        state: "ok",
        data: { complete: true, done: 7, total: 7, items: [] },
      },
      readiness: {
        state: "ok",
        data: {
          overall: "red",
          total: 6,
          ...READINESS,
          overdue: 0,
          running: 0,
          lastCheckedAt: null,
        },
      },
    },
    provider: null,
  };
}

function providerDashboard(): Dashboard {
  return {
    ...tenantDashboard(),
    widgets: {},
    provider: { state: "ok", data: { kpis: {} as never, tenants: [], alerts: [] } },
  };
}

let mounted: Mounted | null = null;
const urls: string[] = [];
let seenSlot: SlotProps["dashboard.provider"] | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  urls.length = 0;
  seenSlot = null;
  router.search = {};
  router.navigate.mockReset();
  registerWebExtension({
    name: "overview-test",
    slots: {
      "dashboard.provider": (props: SlotProps["dashboard.provider"]) => {
        seenSlot = props;
        return <div data-slot="provider-test" data-kind={props.view.kind} />;
      },
    },
  });
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetWebExtensionsForTesting();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function open(session: Parameters<typeof sessionAs>[0]) {
  const setActiveTenant = vi.fn();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return json(url.includes("provider=only") ? providerDashboard() : tenantDashboard());
  });
  mounted = mount(<DashboardPage />, {
    session: sessionAs({
      activeTenant: MUELLER,
      tenants: [OWN, MUELLER, tenant("nord", "Nordlicht AG")],
      features: ["tenants.additional", "dashboard.allTenants"],
      canViewAllTenants: true,
      setActiveTenant,
      ...session,
    }),
  });
  await flush(6);
  return { page: mounted.container, setActiveTenant };
}

const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ");

describe("the overview of a tenant", () => {
  it("shows only that tenant, with no Provider/Tenant tabs and no setup card", async () => {
    const { page } = await open({ scope: "tenant" });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/dashboard$/);
    expect(text(page)).toContain("Showing Müller GmbH");
    // The tabs of the old overview.
    expect(page.querySelector('[aria-label="View"][role="tablist"]')).toBeNull();
    expect(text(page)).not.toMatch(/\bProvider\b/);
    // The setup card, in its open and in its finished state.
    expect(page.querySelector('[data-widget="setup"]')).toBeNull();
    expect(text(page)).not.toContain("Setup complete");
    expect(text(page)).not.toContain("Show steps");
    expect(page.querySelector('[data-widget="readiness"]')).not.toBeNull();
    expect(page.querySelector('[data-slot="provider-test"]')).toBeNull();
  });

  it("links every readiness row that has objects to the table of those objects", async () => {
    const { page } = await open({ scope: "tenant" });
    const href = (segment: string) =>
      page.querySelector(`[data-segment="${segment}"] a`)?.getAttribute("href");
    expect(href("green")).toBe("/verify?state=green");
    expect(href("red")).toBe("/verify?state=red");
    expect(href("unverified")).toBe("/verify?state=unverified");
    expect(page.querySelector('[data-segment="noBackup"] a')).toBeNull();
    expect(page.querySelector('[data-segment="yellow"] a')).toBeNull();
  });

  it("keeps the Statistics tab for an administrator", async () => {
    const { page } = await open({ scope: "tenant" });
    expect(text(page)).toContain("Statistics");
  });
});

describe("the overview under All tenants", () => {
  it("asks for the provider view alone and hands it to the module that draws it", async () => {
    const { page } = await open({ scope: "all" });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/dashboard\?provider=only$/);
    expect(page.querySelector('[data-slot="provider-test"]')?.getAttribute("data-kind")).toBe(
      "ready",
    );
    expect(text(page)).toContain("Showing all tenants");
    // None of the tenant's own widgets, and no tabs: only Status.
    expect(page.querySelector('[data-widget="readiness"]')).toBeNull();
    expect(text(page)).not.toContain("Statistics");
  });

  it("switches into the tenant a row names, staying on the overview", async () => {
    const { setActiveTenant } = await open({ scope: "all" });
    await act(async () => seenSlot?.onOpenTenant("mueller"));
    expect(setActiveTenant).toHaveBeenCalledWith("mueller");
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("switches into the tenant and on to its Recovery readiness in the state asked for", async () => {
    const { setActiveTenant } = await open({ scope: "all" });
    await act(async () => seenSlot?.onOpenReadiness("mueller", "red"));
    expect(setActiveTenant).toHaveBeenCalledWith("mueller");
    expect(router.navigate).toHaveBeenCalledWith({ to: "/verify", search: { state: "red" } });
  });

  it("opens a tenant's own page from its details", async () => {
    await open({ scope: "all" });
    await act(async () => seenSlot?.onTenantDetails("mueller"));
    expect(router.navigate).toHaveBeenCalledWith({ to: "/tenants/mueller/overview" });
  });

  it("does not ask for the provider view while the session is on one tenant", async () => {
    await open({ scope: "tenant" });
    expect(urls.some((url) => url.includes("provider"))).toBe(false);
  });
});
