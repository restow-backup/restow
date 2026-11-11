// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Container, LayoutDashboard, ListChecks, Server } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildPaletteGroups } from "@/components/command-palette/commands";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { ShellModuleHint } from "@/components/layout/module-hidden-hint";
import { SidebarProvider } from "@/components/ui/sidebar";
import "@/features/installation/i18n";
import { i18n } from "@/i18n";
import { MODULE_IDS, type ModuleId } from "@/lib/modules";
import type { NavItem } from "@/lib/navigation";
import { canAccess, type SessionContextValue, StaticSessionProvider } from "@/lib/session";
import { useNavItems } from "@/lib/use-nav-items";

/**
 * The modules of the installation in the shell (0.5.0, lib/modules.ts): an entry of a module
 * that is off is left out of the sidebar and of the command palette, for everyone; its page
 * still opens by its address, where one discreet line says that the module is hidden. An entry
 * that belongs to several modules stays while one of them is on, and an entry that belongs to
 * none is never touched.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NAV: NavItem[] = [
  { id: "dashboard", path: "/", labelKey: "dashboard:nav", icon: LayoutDashboard, exact: true },
  {
    id: "endpoint-jobs",
    path: "/jobs",
    search: { type: "endpoint" },
    labelKey: "nav.items.jobs",
    icon: ListChecks,
    group: "endpoints",
    modules: ["endpoints", "pve"],
  },
  {
    id: "inventory",
    path: "/inventory",
    labelKey: "endpoints:nav.inventory",
    icon: Server,
    group: "endpoints",
    modules: ["endpoints"],
  },
  {
    id: "virtualization",
    path: "/virtualization",
    labelKey: "pve:nav.label",
    icon: Container,
    group: "endpoints",
    modules: ["pve"],
  },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
/** What the command palette would list, captured from the same hook the palette uses. */
let paletteIds: string[] = [];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  paletteIds = [];
  vi.unstubAllGlobals();
});

function sessionWith(
  modules: readonly ModuleId[] | undefined,
  role: "provider_admin" | "tenant_admin",
): SessionContextValue {
  const provider = role === "provider_admin";
  return {
    status: "authenticated",
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role,
    features: [],
    extensions: {},
    ...(modules ? { modules } : {}),
    isProviderAdmin: provider,
    providerRole: provider ? "owner" : null,
    providerAllTenants: provider,
    tenants: [],
    activeTenant: null,
    setActiveTenant: () => undefined,
    scope: "tenant",
    canViewAllTenants: false,
    setScopeAll: () => undefined,
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
  } as SessionContextValue;
}

/** The palette's navigation commands, built from the entries the palette's own hook returns. */
function PaletteProbe({ session }: { session: SessionContextValue }) {
  const navItems = useNavItems();
  paletteIds = buildPaletteGroups({
    navItems,
    role: session.role,
    lockContext: { features: [], extensions: {}, modules: session.modules },
    canAccess,
    tenants: [],
    activeTenantId: null,
    isProviderAdmin: session.isProviderAdmin,
    theme: "system",
    palette: "restow",
    language: "en",
    languages: ["en", "de"],
    t: (key) => key,
  })
    .flatMap((group) => group.commands)
    .map((command) => command.id)
    .filter((id) => id.startsWith("nav:"));
  return null;
}

async function open(
  path: string,
  modules: readonly ModuleId[] | undefined,
  role: "provider_admin" | "tenant_admin" = "provider_admin",
) {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => void store.set(name, value),
    removeItem: (name: string) => void store.delete(name),
  });
  vi.stubGlobal("fetch", () => new Promise(() => undefined));
  const session = sessionWith(modules, role);
  const rootRoute = createRootRouteWithContext<{ navItems: readonly NavItem[] }>()({
    component: () => (
      <SidebarProvider>
        <AppSidebar />
        <main>
          <ShellModuleHint />
          <PaletteProbe session={session} />
        </main>
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      [
        "/",
        "/jobs",
        "/inventory",
        "/virtualization",
        "/virtualization/guests/$id",
        "/installation/$section",
      ].map((routePath) =>
        createRoute({ getParentRoute: () => rootRoute, path: routePath, component: () => null }),
      ),
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

/** The sidebar's entries, by the address each leads to. */
const entry = (href: string) =>
  document.querySelector<HTMLAnchorElement>(`[data-slot="sidebar"] a[href^="${href}"]`);
const hint = () => document.querySelector<HTMLElement>('[data-slot="module-hidden-hint"]');

describe("the menu and the modules of the installation", () => {
  it("lists every entry while every module is on, and on a server from before modules", async () => {
    await open("/", [...MODULE_IDS]);
    expect(entry("/jobs")).not.toBeNull();
    expect(entry("/inventory")).not.toBeNull();
    expect(entry("/virtualization")).not.toBeNull();
    expect(paletteIds).toEqual([
      "nav:dashboard",
      "nav:endpoint-jobs",
      "nav:inventory",
      "nav:virtualization",
    ]);
    expect(hint()).toBeNull();

    act(() => root?.unmount());
    host?.remove();
    await open("/", undefined);
    expect(entry("/virtualization")).not.toBeNull();
    expect(paletteIds).toContain("nav:virtualization");
  });

  it("leaves the entries of a module that is off out of the sidebar and the command palette", async () => {
    await open("/", ["microsoft365", "endpoints"]);
    // Proxmox VE is off: its own entry is gone, in both places.
    expect(entry("/virtualization")).toBeNull();
    expect(paletteIds).not.toContain("nav:virtualization");
    // The machines' entries stay, and so does the one both modules share.
    expect(entry("/inventory")).not.toBeNull();
    expect(entry("/jobs")).not.toBeNull();
    expect(paletteIds).toEqual(["nav:dashboard", "nav:endpoint-jobs", "nav:inventory"]);
    // What belongs to no module is never touched.
    expect(entry("/")).not.toBeNull();
  });

  it("drops a shared entry only once every module it belongs to is off, and then the whole section", async () => {
    await open("/", ["microsoft365"]);
    expect(entry("/jobs")).toBeNull();
    expect(entry("/inventory")).toBeNull();
    expect(entry("/virtualization")).toBeNull();
    expect(paletteIds).toEqual(["nav:dashboard"]);
    // No empty "Servers & clients" heading is left behind.
    expect(document.querySelector('[data-slot="sidebar"]')?.textContent).not.toContain(
      "Servers & clients",
    );
  });

  it("hides the entries for a tenant's own administrator as well: the modules are the installation's", async () => {
    await open("/", ["endpoints"], "tenant_admin");
    expect(entry("/virtualization")).toBeNull();
    expect(entry("/inventory")).not.toBeNull();
  });

  it("still opens the page of a hidden module by its address, with one discreet line that says so", async () => {
    const router = await open("/virtualization", ["microsoft365", "endpoints"]);
    // The address was not redirected: the page is where the link said.
    expect(router.state.location.pathname).toBe("/virtualization");
    expect(entry("/virtualization")).toBeNull();
    const line = hint();
    expect(line).not.toBeNull();
    expect(line?.getAttribute("data-modules")).toBe("pve");
    expect(line?.textContent).toContain("This module is hidden in the navigation: Proxmox VE.");
    // A provider administrator is shown where to switch it on again.
    expect(line?.querySelector("a")?.getAttribute("href")).toBe("/installation/modules");
  });

  it("says the same on a page below the hidden entry, and gives a tenant's administrator no link to the installation", async () => {
    await open("/virtualization/guests/42", ["endpoints"], "tenant_admin");
    const line = hint();
    expect(line?.textContent).toContain("This module is hidden in the navigation: Proxmox VE.");
    expect(line?.querySelector("a")).toBeNull();
  });

  it("says nothing on the page of a module that is on, nor on a page that belongs to none", async () => {
    await open("/virtualization", ["pve"]);
    expect(hint()).toBeNull();
    expect(entry("/virtualization")).not.toBeNull();

    act(() => root?.unmount());
    host?.remove();
    // The shared jobs entry: Proxmox VE is on, so the page is not a hidden one.
    await open("/jobs?type=endpoint", ["pve"]);
    expect(hint()).toBeNull();
  });
});
