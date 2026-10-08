import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @vitest-environment happy-dom
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Building2, History, Settings } from "lucide-react";
import * as React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { i18n } from "@/i18n";
import type { NavItem } from "@/lib/navigation";
import { type SessionContextValue, type SessionTenant, StaticSessionProvider } from "@/lib/session";

/**
 * The tenant switcher at the top of the sidebar in a real DOM: the trigger
 * (one structure for every tenant, one height), the dropdown (own
 * organisation first, search by name and customer number, full names, the
 * keyboard), the gear to the tenant settings, the static display of an
 * installation with one tenant, the collapsed rail and the mobile sheet.
 * Layout itself cannot be measured in happy-dom, so the height and the
 * truncation are pinned through their classes.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG_NAME = "Stadtwerke Overath Netz- und Versorgungsgesellschaft mit beschränkter Haftung";

function tenant(
  overrides: Partial<SessionTenant> & Pick<SessionTenant, "id" | "name">,
): SessionTenant {
  return {
    slug: overrides.id,
    kind: "customer",
    customerNumber: null,
    role: "tenant_admin",
    status: "active",
    ...overrides,
  };
}

const OWN = tenant({ id: "own", name: "IT Systeme Flores", kind: "internal" });
const MUELLER = tenant({ id: "mueller", name: "Müller GmbH", customerNumber: "KD-10234" });
const NORDLICHT = tenant({ id: "nordlicht", name: "Nordlicht AG", customerNumber: "KD-10187" });
const STADTWERKE = tenant({ id: "stadtwerke", name: LONG_NAME, customerNumber: "KD-10055" });
const KRUEGER = tenant({ id: "krueger", name: "Bäckerei Krüger" });
const RUHENDER = tenant({
  id: "ruhender",
  name: "Ruhender Betrieb",
  customerNumber: "KD-10999",
  status: "suspended",
});

/** What the API lists for a provider admin: the own organisation first. */
const ALL = [OWN, MUELLER, NORDLICHT, STADTWERKE, KRUEGER, RUHENDER];

const NAV: NavItem[] = [
  {
    id: "history",
    path: "/history",
    labelKey: "backup:nav.history",
    icon: History,
    group: "daily",
    // A count next to the label, as the warnings entry has one.
    useBadge: () => ({ count: 3, label: "3 open warnings" }),
  },
  {
    id: "tenant-settings",
    path: "/protected-objects",
    labelKey: "nav.items.tenantSettings",
    icon: Settings,
    group: "tenants",
    roles: ["provider_admin", "tenant_admin"],
    visible: (context) => (context.features ?? []).includes("tenants.additional"),
  },
  {
    id: "organisation-settings",
    path: "/protected-objects",
    labelKey: "nav.items.organisationSettings",
    icon: Settings,
    group: "tenants",
    roles: ["provider_admin", "tenant_admin"],
    visible: (context) => !(context.features ?? []).includes("tenants.additional"),
  },
  {
    id: "tenants",
    path: "/tenants",
    labelKey: "tenants:nav.tenants",
    icon: Building2,
    group: "tenants",
    roles: ["provider_admin"],
  },
];

interface Scenario {
  tenants?: SessionTenant[];
  active?: SessionTenant;
  role?: SessionContextValue["role"];
  features?: SessionContextValue["features"];
  /** Remembered sidebar state: "collapsed" shows the icon rail. */
  sidebar?: "collapsed";
  /** A phone-sized window, so the sidebar is a sheet. */
  mobile?: boolean;
  /** Render the whole sidebar (the wordmark, the sections) instead of the switcher alone. */
  fullSidebar?: boolean;
  /** "All tenants" is on offer (a provider admin of a Service Provider installation). */
  canViewAllTenants?: boolean;
  /** The session works on "All tenants". */
  scope?: "tenant" | "all";
}

const setActiveTenant = vi.fn();
const setScopeAll = vi.fn();

function sessionOf(scenario: Scenario): SessionContextValue {
  const tenants = scenario.tenants ?? ALL;
  const role = scenario.role ?? "provider_admin";
  const active = scenario.active ?? tenants[0] ?? null;
  return {
    status: "authenticated",
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role,
    features: scenario.features ?? ["tenants.additional"],
    extensions: {},
    isProviderAdmin: role === "provider_admin",
    tenants,
    activeTenant: active,
    setActiveTenant,
    scope: scenario.scope ?? "tenant",
    canViewAllTenants: scenario.canViewAllTenants ?? false,
    setScopeAll,
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
  } as SessionContextValue;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/** The sidebar primitive remembers its state in local storage; happy-dom's here is not usable. */
function stubStorage(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => void store.set(name, value),
    removeItem: (name: string) => void store.delete(name),
  });
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // happy-dom lacks what cmdk and Radix measure with.
  const proto = Element.prototype as { scrollIntoView?: () => void };
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  setActiveTenant.mockReset();
  setScopeAll.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  window.innerWidth = 1024;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Opens the mobile sheet as soon as the sidebar primitive is there. */
function OpenSheet() {
  const { setOpenMobile } = useSidebar();
  React.useEffect(() => setOpenMobile(true), [setOpenMobile]);
  return null;
}

async function render(scenario: Scenario = {}, path = "/history") {
  stubStorage(scenario.sidebar ? { "restow.sidebar": scenario.sidebar } : {});
  // The sidebar's Start entry asks for the setup checklist: it never answers here.
  vi.stubGlobal("fetch", () => new Promise(() => undefined));
  if (scenario.mobile) {
    window.innerWidth = 400;
  }
  const rootRoute = createRootRouteWithContext<{ navItems: readonly NavItem[] }>()({
    component: () => (
      <SidebarProvider>
        {scenario.mobile ? <OpenSheet /> : null}
        {scenario.fullSidebar ? <AppSidebar /> : <TenantSwitcher />}
      </SidebarProvider>
    ),
  });
  const page = (p: string) =>
    createRoute({ getParentRoute: () => rootRoute, path: p, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ["/", "/history", "/protected-objects", "/tenants", "/tenants/mueller/overview"].map(page),
    ),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { navItems: NAV },
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
          <StaticSessionProvider value={sessionOf(scenario)}>
            <RouterProvider router={router} />
          </StaticSessionProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await tick();
  });
  return router;
}

const trigger = () =>
  document.querySelector<HTMLButtonElement>('[data-slot="tenant-switcher-trigger"]');
const input = () => document.querySelector<HTMLInputElement>('[data-slot="command-input"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')];
const tenantOptions = () =>
  options().filter(
    (option) =>
      option.hasAttribute("data-current") ||
      option.querySelector('[data-slot="tenant-option-name"]'),
  );
const names = () =>
  tenantOptions().map(
    (option) => option.querySelector('[data-slot="tenant-option-name"]')?.textContent,
  );

async function open() {
  await act(async () => {
    trigger()?.click();
    await tick();
  });
}

async function typeSearch(text: string) {
  const field = input();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, text);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  });
}

async function key(target: Element | null, name: string) {
  await act(async () => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    await tick();
  });
}

describe("the trigger", () => {
  it("is a button that announces the dropdown, naming the active tenant", async () => {
    await render({ active: MUELLER });
    const button = trigger();
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("aria-label")).toBe("Switch tenant, current: Müller GmbH");
    expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    // A native button: Enter and Space open it without any key handling of ours.
    expect(button?.getAttribute("tabindex")).toBeNull();
  });

  it("shows the name on one line and the customer number in mono below it", async () => {
    await render({ active: MUELLER });
    const name = document.querySelector('[data-slot="tenant-name"]');
    expect(name?.textContent).toBe("Müller GmbH");
    expect(name?.className).toContain("truncate");
    const subline = document.querySelector('[data-slot="tenant-subline"]');
    const number = subline?.querySelector(".font-mono");
    expect(number?.textContent).toContain("KD-10234");
    // The number is announced as one.
    expect(number?.querySelector(".sr-only")?.textContent).toBe("Customer number ");
  });

  it("says Internal for the own organisation, even with a customer number", async () => {
    await render({ active: tenant({ ...OWN, customerNumber: "KD-1" }) });
    const subline = document.querySelector('[data-slot="tenant-subline"]');
    expect(subline?.textContent).toBe("Internal");
    expect(subline?.querySelector(".font-mono")).toBeNull();
  });

  it("says Tenant for a tenant without a customer number", async () => {
    await render({ active: KRUEGER });
    expect(document.querySelector('[data-slot="tenant-subline"]')?.textContent).toBe("Tenant");
  });

  it("gives a long name as the title and cuts it to one line", async () => {
    await render({ active: STADTWERKE });
    expect(trigger()?.getAttribute("title")).toBe(LONG_NAME);
    expect(document.querySelector('[data-slot="tenant-name"]')?.textContent).toBe(LONG_NAME);
    expect(document.querySelector('[data-slot="tenant-name"]')?.className).toContain("truncate");
  });

  it("keeps one structure and one height whichever tenant is active", async () => {
    /**
     * The trigger's tag names and classes. Left out: the text, the per-tenant
     * badge, the screen-reader-only prefix and what is inside an icon (a
     * shield for the own organisation, a building for the rest).
     */
    function shape(): string[] {
      const button = trigger();
      const walk = (element: Element, depth: number): string[] => [
        `${depth}:${element.tagName}:${(element.getAttribute("class") ?? "").replace(/lucide-(shield|building2)/, "lucide-mark")}`,
        ...(element.tagName === "svg" ? [] : [...element.children])
          .filter(
            (child) =>
              child.getAttribute("data-slot") !== "badge" && !child.classList.contains("sr-only"),
          )
          .flatMap((child) => walk(child, depth + 1)),
      ];
      return button ? walk(button, 0) : [];
    }
    const shapes: string[][] = [];
    for (const active of [OWN, MUELLER, STADTWERKE, KRUEGER]) {
      await render({ active });
      shapes.push(shape());
      expect(trigger()?.className, active.name).toContain("h-12");
      act(() => root?.unmount());
      host?.remove();
    }
    const [first, ...rest] = shapes;
    expect(first?.length).toBeGreaterThan(4);
    for (const other of rest) {
      // The number is mono, the other second lines are not: that one class is the only difference.
      expect(other.map((line) => line.replace(" font-mono", ""))).toEqual(
        (first ?? []).map((line) => line.replace(" font-mono", "")),
      );
    }
  });

  it("marks a suspended tenant in the trigger and keeps the same height", async () => {
    await render({ active: RUHENDER });
    const badge = document.querySelector('[data-slot="tenant-subline"] [data-slot="badge"]');
    expect(badge?.textContent).toBe("Suspended");
    expect(badge?.getAttribute("data-variant")).toBe("warning");
    expect(trigger()?.className).toContain("h-12");
  });
});

describe("the dropdown", () => {
  it("lists the own organisation first, with an Internal badge in the Lapis tint, not green", async () => {
    // The session lists it last; the switcher puts it on top all the same.
    await render({ tenants: [MUELLER, NORDLICHT, OWN], active: MUELLER });
    await open();
    expect(names()).toEqual(["IT Systeme Flores", "Müller GmbH", "Nordlicht AG"]);
    const badge = tenantOptions()[0]?.querySelector('[data-slot="badge"]');
    expect(badge?.textContent).toBe("Internal");
    expect(badge?.getAttribute("data-variant")).toBe("info");
    expect(badge?.className).not.toMatch(/success/);
    // No other tenant carries it.
    expect(tenantOptions()[1]?.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("is wider than the sidebar and may overlap the page", async () => {
    await render();
    await open();
    const content = document.querySelector('[data-slot="popover-content"]');
    // About 150 % of the sidebar's 16rem, never wider than the window.
    expect(content?.className).toContain("w-[min(24rem,calc(100vw-1rem))]");
  });

  it("shows full names that wrap instead of being cut, each with its customer number in mono", async () => {
    await render({ active: MUELLER });
    await open();
    const long = tenantOptions().find((option) => option.textContent?.includes(LONG_NAME));
    const name = long?.querySelector('[data-slot="tenant-option-name"]');
    expect(name?.textContent).toBe(LONG_NAME);
    expect(name?.className).toContain("[overflow-wrap:anywhere]");
    expect(name?.className).not.toContain("truncate");
    const number = long?.querySelector('[data-slot="tenant-option-number"]');
    expect(number?.textContent).toBe("KD-10055");
    expect(number?.className).toContain("font-mono");
    // A tenant without a number shows none.
    const krueger = tenantOptions().find((option) => option.textContent?.includes("Krüger"));
    expect(krueger?.querySelector('[data-slot="tenant-option-number"]')).toBeNull();
  });

  it("shows the role in each tenant, a suspended tenant with its badge and closed to members", async () => {
    await render({ role: "tenant_admin", tenants: [MUELLER, RUHENDER], active: MUELLER });
    await open();
    const [first, second] = tenantOptions();
    expect(first?.textContent).toContain("Tenant admin");
    expect(second?.querySelector('[data-slot="badge"]')?.textContent).toBe("Suspended");
    expect(second?.textContent).toContain("only the provider can open it");
    expect(second?.getAttribute("data-disabled")).toBe("true");
    // A provider admin may open it.
    act(() => root?.unmount());
    host?.remove();
    await render({ tenants: [MUELLER, RUHENDER], active: MUELLER });
    await open();
    expect(tenantOptions()[1]?.getAttribute("data-disabled")).toBe("false");
    expect(tenantOptions()[1]?.textContent).toContain("Provider admin");
  });

  it("marks the current tenant", async () => {
    await render({ active: NORDLICHT });
    await open();
    const current = tenantOptions().filter(
      (option) => option.getAttribute("data-current") === "true",
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Nordlicht AG");
    expect(current[0]?.textContent).toContain("Current tenant");
  });
});

describe("the search", () => {
  it("finds a tenant by name, any part of it", async () => {
    await render({ active: MUELLER });
    await open();
    await typeSearch("nordl");
    expect(names()).toEqual(["Nordlicht AG"]);
    await typeSearch("overath");
    expect(names()).toEqual([LONG_NAME]);
  });

  it("finds a tenant by customer number, whole or in part", async () => {
    await render({ active: MUELLER });
    await open();
    await typeSearch("KD-10187");
    expect(names()).toEqual(["Nordlicht AG"]);
    await typeSearch("kd-1005");
    expect(names()).toEqual([LONG_NAME]);
    await typeSearch("10234");
    expect(names()).toEqual(["Müller GmbH"]);
  });

  it("ignores accents: 'muller' finds Müller, 'backerei' finds Bäckerei", async () => {
    await render({ active: MUELLER });
    await open();
    await typeSearch("muller");
    expect(names()).toEqual(["Müller GmbH"]);
    await typeSearch("backerei");
    expect(names()).toEqual(["Bäckerei Krüger"]);
  });

  it("says so when nothing matches, and lists everything again for an empty search", async () => {
    await render({ active: MUELLER });
    await open();
    await typeSearch("zzzz");
    expect(names()).toEqual([]);
    expect(document.querySelector('[data-slot="command-empty"]')?.textContent).toBe(
      "No matching tenant.",
    );
    await typeSearch("");
    expect(names()).toHaveLength(ALL.length);
  });

  it("has a field named for what it searches", async () => {
    await render();
    await open();
    expect(input()?.getAttribute("placeholder")).toBe("Search by name or customer number …");
    expect(input()?.getAttribute("aria-label")).toBe("Search by name or customer number …");
  });
});

describe("Manage tenants", () => {
  it("is offered to a provider admin at the bottom, and stays when the search finds nothing", async () => {
    await render({ active: MUELLER });
    await open();
    const manage = () => options().find((option) => option.textContent?.includes("Manage tenants"));
    expect(manage()).toBeDefined();
    // Last in the list.
    expect(options().at(-1)).toBe(manage());
    await typeSearch("zzzz");
    expect(manage()).toBeDefined();
  });

  it("is not offered to a tenant admin, who has no list of all tenants", async () => {
    await render({ role: "tenant_admin", tenants: [MUELLER, NORDLICHT], active: MUELLER });
    await open();
    expect(options().some((option) => option.textContent?.includes("Manage tenants"))).toBe(false);
  });

  it("opens the list of all tenants", async () => {
    const router = await render({ active: MUELLER });
    await open();
    const manage = options().find((option) => option.textContent?.includes("Manage tenants"));
    await act(async () => {
      manage?.click();
      await tick();
    });
    expect(router.state.location.pathname).toBe("/tenants");
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });
});

const allOption = () => document.querySelector<HTMLElement>('[data-option="all-tenants"]');

describe("All tenants", () => {
  it("is the first entry for a provider admin who may look across tenants", async () => {
    await render({ active: MUELLER, canViewAllTenants: true });
    await open();
    expect(options()[0]).toBe(allOption());
    expect(allOption()?.textContent).toContain("All tenants");
    // The sum across the customers: the own organisation is not counted.
    expect(allOption()?.textContent).toContain("Sum across all 5 tenants");
  });

  it("is not offered where the installation has one organisation, or to a role that may not look across", async () => {
    await render({ active: MUELLER });
    await open();
    expect(allOption()).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    await render({ role: "tenant_admin", tenants: [MUELLER, NORDLICHT], active: MUELLER });
    await open();
    expect(allOption()).toBeNull();
  });

  it("puts the session into All tenants, once", async () => {
    await render({ active: MUELLER, canViewAllTenants: true });
    await open();
    await act(async () => {
      allOption()?.click();
      await tick();
    });
    expect(setScopeAll).toHaveBeenCalledOnce();
    expect(setActiveTenant).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it("gives the page of a tenant way to the overview first, so that page cannot take the scope away again", async () => {
    const order: string[] = [];
    setScopeAll.mockImplementation(() => order.push("scope"));
    const router = await render(
      { active: MUELLER, canViewAllTenants: true },
      "/tenants/mueller/overview",
    );
    await open();
    await act(async () => {
      allOption()?.click();
      await tick();
      await tick();
    });
    expect(router.state.location.pathname).toBe("/");
    expect(setScopeAll).toHaveBeenCalledOnce();
  });

  it("names the scope on the trigger instead of the tenant that stays active underneath", async () => {
    await render({ active: MUELLER, canViewAllTenants: true, scope: "all" });
    expect(document.querySelector('[data-slot="tenant-name"]')?.textContent).toBe("All tenants");
    expect(document.querySelector('[data-slot="tenant-subline"]')?.textContent).toBe("5 tenants");
    expect(trigger()?.getAttribute("data-scope")).toBe("all");
    expect(trigger()?.getAttribute("aria-label")).toBe("Switch tenant, current: All tenants");
    await open();
    // All tenants is the chosen one, no tenant is.
    expect(allOption()?.getAttribute("data-current")).toBe("true");
    expect(
      tenantOptions().filter(
        (option) => option !== allOption() && option.hasAttribute("data-current"),
      ),
    ).toHaveLength(0);
  });

  it("leaves All tenants by choosing a tenant, also the one that stayed active", async () => {
    await render({ active: MUELLER, canViewAllTenants: true, scope: "all" });
    await open();
    const mueller = options().find((option) => option.textContent?.includes("Müller GmbH"));
    await act(async () => {
      mueller?.click();
      await tick();
    });
    expect(setActiveTenant).toHaveBeenCalledWith("mueller");
  });

  it("sends the gear to the list of tenants while there is no tenant to open", async () => {
    await render({ active: MUELLER, canViewAllTenants: true, scope: "all", fullSidebar: true });
    const gear = document.querySelector('[data-slot="tenant-settings-link"]');
    expect(gear?.getAttribute("aria-label")).toBe("Manage tenants");
  });
});

describe("the keyboard", () => {
  it("moves focus to the search field when the dropdown opens", async () => {
    await render({ active: MUELLER });
    act(() => trigger()?.focus());
    await open();
    expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(input());
  });

  it("starts the arrow keys at the active tenant, moves with them and selects with Enter", async () => {
    await render({ active: MUELLER });
    await open();
    const selected = () =>
      tenantOptions()
        .filter((option) => option.getAttribute("data-selected") === "true")
        .map((option) => option.querySelector('[data-slot="tenant-option-name"]')?.textContent);
    expect(selected()).toEqual(["Müller GmbH"]);
    await key(input(), "ArrowDown");
    expect(selected()).toEqual(["Nordlicht AG"]);
    await key(input(), "ArrowUp");
    await key(input(), "ArrowUp");
    expect(selected()).toEqual(["IT Systeme Flores"]);
    await key(input(), "ArrowDown");
    await key(input(), "ArrowDown");
    await key(input(), "Enter");
    expect(setActiveTenant).toHaveBeenCalledTimes(1);
    expect(setActiveTenant).toHaveBeenCalledWith("nordlicht");
    // The dropdown closes after the choice.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it("types to filter and selects the one that is left with Enter", async () => {
    await render({ active: MUELLER });
    await open();
    await typeSearch("KD-10187");
    await key(input(), "Enter");
    expect(setActiveTenant).toHaveBeenCalledWith("nordlicht");
  });

  it("does not select a tenant that is closed to the person", async () => {
    await render({ role: "tenant_admin", tenants: [MUELLER, RUHENDER], active: MUELLER });
    await open();
    await typeSearch("Ruhender");
    await key(input(), "Enter");
    expect(setActiveTenant).not.toHaveBeenCalled();
  });

  it("closes with Escape and returns focus to the trigger", async () => {
    await render({ active: MUELLER });
    act(() => trigger()?.focus());
    await open();
    await key(input(), "Escape");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
    expect(setActiveTenant).not.toHaveBeenCalled();
  });
});

describe("the gear", () => {
  const gear = () =>
    document.querySelector<HTMLAnchorElement>('[data-slot="tenant-settings-link"]');

  it("opens the settings of the active tenant, named for it", async () => {
    await render({ active: MUELLER });
    expect(gear()?.getAttribute("href")).toBe("/protected-objects");
    expect(gear()?.getAttribute("aria-label")).toBe("Open settings of Müller GmbH");
    expect(gear()?.tagName).toBe("A");
  });

  it("leads where the menu entry leads, for tenant management and for one organisation", async () => {
    const entry = (features: SessionContextValue["features"]) =>
      NAV.filter((item) => (item.visible ? item.visible({ features, extensions: {} }) : true)).find(
        (item) => item.id === "tenant-settings" || item.id === "organisation-settings",
      );
    for (const features of [["tenants.additional" as const], []]) {
      await render({ active: MUELLER, features });
      expect(gear()?.getAttribute("href")).toBe(entry(features)?.path);
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("is there for a tenant admin and absent for an end user", async () => {
    await render({ role: "tenant_admin", tenants: [MUELLER, NORDLICHT], active: MUELLER });
    expect(gear()).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();
    await render({ role: "tenant_user", tenants: [MUELLER, NORDLICHT], active: MUELLER });
    expect(gear()).toBeNull();
    // The switcher itself stays: the end user may have several tenants.
    expect(trigger()).not.toBeNull();
  });

  it("navigates to the settings when used", async () => {
    const router = await render({ active: MUELLER });
    await act(async () => {
      gear()?.click();
      await tick();
    });
    expect(router.state.location.pathname).toBe("/protected-objects");
  });
});

describe("an installation with one tenant", () => {
  it("shows the organisation's name statically, with the gear and no dropdown", async () => {
    await render({ tenants: [OWN], active: OWN, features: [] });
    expect(trigger()).toBeNull();
    const fixed = document.querySelector('[data-slot="tenant-switcher-static"]');
    expect(fixed?.tagName).toBe("DIV");
    expect(fixed?.getAttribute("title")).toBe("IT Systeme Flores");
    expect(fixed?.querySelector('[data-slot="tenant-name"]')?.textContent).toBe(
      "IT Systeme Flores",
    );
    // Nothing to open, nothing to switch to.
    expect(fixed?.getAttribute("aria-haspopup")).toBeNull();
    expect(document.querySelector('[data-slot="tenant-switcher"] button')).toBeNull();
    expect(document.querySelector('[data-slot="tenant-settings-link"]')).not.toBeNull();
    expect(fixed?.className).toContain("h-12");
  });

  it("calls it Organisation, never Internal or Tenant", async () => {
    await render({ tenants: [OWN], active: OWN, features: [] });
    expect(document.querySelector('[data-slot="tenant-subline"]')?.textContent).toBe(
      "Organisation",
    );
  });

  it("shows the customer number when it has one", async () => {
    await render({ tenants: [MUELLER], active: MUELLER, features: [] });
    expect(
      document.querySelector('[data-slot="tenant-subline"] .font-mono')?.textContent,
    ).toContain("KD-10234");
  });

  it("is static for a Service Provider installation with one tenant too (nothing to choose)", async () => {
    await render({ tenants: [OWN], active: OWN });
    expect(trigger()).toBeNull();
    expect(document.querySelector('[data-slot="tenant-subline"]')?.textContent).toBe("Internal");
  });
});

describe("without a tenant", () => {
  it("says so in a box of the same height", async () => {
    await render({ tenants: [], active: undefined });
    expect(trigger()).toBeNull();
    expect(document.querySelector('[data-slot="tenant-switcher"]')).toBeNull();
    expect(document.body.textContent).toContain("No tenant");
  });
});

describe("the collapsed icon rail", () => {
  it("keeps the trigger, drops its title (the tooltip carries the name) and opens the same dropdown", async () => {
    await render({ active: MUELLER, sidebar: "collapsed", fullSidebar: true });
    const button = trigger();
    expect(button).not.toBeNull();
    // Expanded, the full name is the title; collapsed, the tooltip says it.
    expect(button?.getAttribute("title")).toBeNull();
    // The name stays for assistive technology, the text is hidden from sight only.
    expect(button?.getAttribute("aria-label")).toBe("Switch tenant, current: Müller GmbH");
    expect(button?.className).toContain("group-data-[collapsible=icon]:size-8");
    expect(button?.querySelector('[data-slot="tenant-name"]')?.parentElement?.className).toContain(
      "group-data-[collapsible=icon]:sr-only",
    );
    await open();
    expect(names()).toHaveLength(ALL.length);
    expect(input()).not.toBeNull();
  });

  it("hides the gear (the menu entry has its tooltip) and shows the wordmark as the mark only", async () => {
    await render({ active: MUELLER, sidebar: "collapsed", fullSidebar: true });
    const link = document.querySelector('[data-slot="tenant-settings-link"]');
    expect(link?.className).toContain("group-data-[collapsible=icon]:hidden");
  });

  it("shows the static organisation as its mark with the name in a tooltip", async () => {
    await render({
      tenants: [OWN],
      active: OWN,
      features: [],
      sidebar: "collapsed",
      fullSidebar: true,
    });
    const fixed = document.querySelector('[data-slot="tenant-switcher-static"]');
    expect(fixed?.getAttribute("title")).toBeNull();
    expect(fixed?.getAttribute("tabindex")).toBe("0");
  });
});

describe("the mobile sheet", () => {
  it("has the switcher first, right below the wordmark and above the first section", async () => {
    await render({ active: MUELLER, mobile: true, fullSidebar: true });
    const sheet = document.querySelector('[data-slot="sidebar"][data-mobile="true"]');
    expect(sheet).not.toBeNull();
    const controls = [...(sheet?.querySelectorAll("a, button") ?? [])];
    // The wordmark, then the switcher, then the gear, then the menu.
    expect(controls[0]?.getAttribute("href")).toBe("/");
    expect(controls[1]).toBe(trigger());
    expect(controls[2]?.getAttribute("data-slot")).toBe("tenant-settings-link");
    const label = sheet?.querySelector('[data-sidebar="group-label"]');
    const position = trigger()?.compareDocumentPosition(label as Node) ?? 0;
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sheet?.querySelectorAll('[data-slot="tenant-switcher-trigger"]')).toHaveLength(1);
  });

  it("opens the same dropdown above the sheet, and closes the sheet after a choice", async () => {
    await render({ active: MUELLER, mobile: true, fullSidebar: true });
    await open();
    expect(names()).toHaveLength(ALL.length);
    // The dropdown fits a phone: never wider than the window.
    expect(document.querySelector('[data-slot="popover-content"]')?.className).toContain(
      "calc(100vw-1rem)",
    );
    const nordlicht = tenantOptions().find((option) => option.textContent?.includes("Nordlicht"));
    await act(async () => {
      nordlicht?.click();
      await tick();
    });
    expect(setActiveTenant).toHaveBeenCalledWith("nordlicht");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();
  });
});

describe("a count next to a menu entry", () => {
  it("shows the entry's count and says it to assistive technology", async () => {
    await render({ active: MUELLER, fullSidebar: true });
    const badge = document.querySelector('[data-slot="nav-badge"]');
    expect(badge?.textContent).toBe("3");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(badge?.closest("a")?.textContent).toContain(", 3 open warnings");
  });

  it("leaves it out where the entry needs a tenant and none is active", async () => {
    await render({ active: MUELLER, canViewAllTenants: true, scope: "all", fullSidebar: true });
    expect(document.querySelector('[data-slot="nav-badge"]')).toBeNull();
  });
});
