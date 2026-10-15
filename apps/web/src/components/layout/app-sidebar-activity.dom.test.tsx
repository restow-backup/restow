// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { i18n } from "@/i18n";
import type { NavActivity, NavBadge, NavItem } from "@/lib/navigation";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";

/**
 * Work behind a menu entry (#57): a spinner with the number of backups that run, those that wait
 * muted, the words for a screen reader, the way to the running backup, and a dot on the icon of
 * the collapsed rail. Running is Lapis, never the green of proof.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [
  {
    id: "r1",
    label: "Mail backup · anna@contoso.example",
    percent: 45,
    to: "/jobs",
    search: { type: "mail", run: "r1" },
  },
  {
    id: "r2",
    label: "Mail backup · ben@contoso.example",
    percent: null,
    to: "/jobs",
    search: { type: "mail", run: "r2" },
  },
];

let badge: NavBadge | null = null;

function activityBadge(activity: NavActivity, label: string): NavBadge {
  return { count: activity.running, label, activity };
}

const NAV: NavItem[] = [
  {
    id: "mail-jobs",
    path: "/jobs",
    search: { type: "mail" },
    labelKey: "nav.items.jobs",
    icon: ListChecks,
    group: "mail",
    useBadge: () => badge,
  },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  badge = null;
  vi.unstubAllGlobals();
});

async function render(options: { collapsed?: boolean } = {}) {
  const store = new Map<string, string>(options.collapsed ? [["restow.sidebar", "collapsed"]] : []);
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => void store.set(name, value),
    removeItem: (name: string) => void store.delete(name),
  });
  // The sidebar's Start entry asks for the setup checklist: it never answers here.
  vi.stubGlobal("fetch", () => new Promise(() => undefined));
  const rootRoute = createRootRouteWithContext<{ navItems: readonly NavItem[] }>()({
    component: () => (
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ["/", "/jobs"].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { navItems: NAV },
  });
  await router.load();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const tenant = {
    id: "t1",
    slug: "t1",
    name: "Contoso",
    kind: "customer",
    customerNumber: null,
    role: "tenant_admin",
    status: "active",
  } as const;
  const session = {
    status: "authenticated",
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role: "tenant_admin",
    features: [],
    extensions: {},
    isProviderAdmin: false,
    tenants: [tenant],
    activeTenant: tenant,
    setActiveTenant: () => undefined,
    scope: "tenant",
    canViewAllTenants: false,
    setScopeAll: () => undefined,
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
  } as unknown as SessionContextValue;
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <StaticSessionProvider value={session}>
            <RouterProvider router={router} />
          </StaticSessionProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return router;
}

const control = () => document.querySelector<HTMLElement>('[data-slot="nav-activity"]');
const entry = () => document.querySelector<HTMLAnchorElement>('a[href^="/jobs"]');
const dot = () => document.querySelector<HTMLElement>('[data-slot="nav-activity-dot"]');

describe("backups running behind Jobs", () => {
  it("shows a spinner with the running ones, the waiting ones muted, and says both", async () => {
    badge = activityBadge({ running: 2, queued: 1, items: ITEMS }, "2 backups running, 1 waiting");
    await render();
    const face = control();
    expect(face?.textContent).toBe("2+1");
    const spinner = face?.querySelector("svg");
    // A spinner where motion is allowed, a still dot where it is not.
    expect(spinner?.getAttribute("class")).toContain("motion-safe:animate-spin");
    expect(spinner?.getAttribute("class")).toContain("motion-reduce:hidden");
    expect(face?.querySelector(".motion-reduce\\:inline-block")).not.toBeNull();
    // Lapis, never the green of proof.
    expect(face?.className).toContain("text-info-text");
    expect(face?.outerHTML).not.toMatch(/success/);
    // The entry says it to a screen reader; the drawn count is not read twice.
    expect(entry()?.textContent).toContain("Jobs, 2 backups running, 1 waiting");
    expect(document.querySelector('[data-slot="nav-badge"]')).toBeNull();
    // Several run: the control is a menu button with a name.
    expect(face?.tagName).toBe("BUTTON");
    expect(face?.getAttribute("aria-label")).toBe(
      "2 backups running, 1 waiting. Show the running backups",
    );
    expect(face?.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("opens the one running backup with a click", async () => {
    badge = activityBadge(
      { running: 1, queued: 0, items: [ITEMS[0] as (typeof ITEMS)[number]] },
      "1 backup running",
    );
    await render();
    const face = control();
    expect(face?.tagName).toBe("A");
    expect(face?.getAttribute("href")).toBe("/jobs?type=mail&run=r1");
    expect(face?.getAttribute("aria-label")).toBe(
      "1 backup running. Open the running backup: Mail backup · anna@contoso.example",
    );
  });

  it("shows only a muted clock while backups wait and none runs", async () => {
    badge = activityBadge({ running: 0, queued: 3, items: [] }, "3 waiting");
    await render();
    const face = control();
    expect(face?.textContent).toBe("3");
    expect(face?.className).toContain("text-sidebar-foreground/60");
    expect(face?.querySelector(".animate-spin, .motion-safe\\:animate-spin")).toBeNull();
    expect(entry()?.textContent).toContain("Jobs, 3 waiting");
  });

  it("shows nothing while nothing runs", async () => {
    badge = null;
    await render();
    expect(control()).toBeNull();
    expect(dot()).toBeNull();
  });

  it("puts a dot on the icon of the collapsed rail, pulsing only where motion is allowed", async () => {
    badge = activityBadge({ running: 2, queued: 0, items: ITEMS }, "2 backups running");
    await render({ collapsed: true });
    expect(dot()?.className).toContain("group-data-[collapsible=icon]:block");
    expect(dot()?.className).toContain("motion-safe:animate-pulse");
    expect(dot()?.className).toContain("bg-info");
    // The count itself is not drawn on the rail.
    expect(control()?.className).toContain("group-data-[collapsible=icon]:hidden");
  });
});
