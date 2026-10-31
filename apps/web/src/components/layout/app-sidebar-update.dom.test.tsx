// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ListChecks, ServerCog } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { i18n } from "@/i18n";
import type { ProviderRole } from "@/lib/api";
import type { NavItem } from "@/lib/navigation";
import {
  type RunningVersion,
  type SessionContextValue,
  StaticSessionProvider,
} from "@/lib/session";

/**
 * A newer release in the sidebar (0.5.0): a blue dot beside "Version 0.4.8" in the footer and on
 * the installation entry that leads to Updates, for provider administrators only. Info colour,
 * never green; a pulse only where motion is allowed; the words ("Update to 0.4.9 available")
 * for assistive technology.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NAV: NavItem[] = [
  {
    id: "mail-jobs",
    path: "/jobs",
    labelKey: "nav.items.jobs",
    icon: ListChecks,
    group: "mail",
  },
  {
    id: "settings",
    path: "/installation",
    labelKey: "installation:nav",
    icon: ServerCog,
    roles: ["provider_admin"],
    group: "installation",
    leadsToUpdates: true,
  },
  {
    id: "other-installation",
    path: "/installation-other",
    labelKey: "nav.items.jobs",
    icon: ListChecks,
    roles: ["provider_admin"],
    group: "installation",
  },
];

const AVAILABLE: RunningVersion = {
  running: "0.4.8",
  commit: null,
  latest: "0.4.9",
  updateAvailable: true,
  releaseUrl: "https://example.test/releases/v0.4.9",
};

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
  vi.unstubAllGlobals();
});

async function render(
  who: { kind: "provider"; providerRole: ProviderRole } | { kind: "tenant" },
  version: RunningVersion | null,
) {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => void store.set(name, value),
    removeItem: (name: string) => void store.delete(name),
  });
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
      ["/", "/jobs", "/installation", "/installation-other", "/installation/updates"].map((path) =>
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
  const provider = who.kind === "provider";
  const session = {
    status: "authenticated",
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role: provider ? "provider_admin" : "tenant_admin",
    features: [],
    extensions: {},
    isProviderAdmin: provider,
    providerRole: provider ? who.providerRole : null,
    providerAllTenants: provider,
    tenants: [tenant],
    activeTenant: tenant,
    setActiveTenant: () => undefined,
    scope: "tenant",
    canViewAllTenants: false,
    setScopeAll: () => undefined,
    version,
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
}

const dots = () => [...document.querySelectorAll<HTMLElement>('[data-slot="update-dot"]')];
const footerLink = () => document.querySelector<HTMLAnchorElement>('[data-slot="version-update"]');
const installationEntry = () =>
  document.querySelector<HTMLAnchorElement>('a[href="/installation"]');
const otherEntry = () => document.querySelector<HTMLAnchorElement>('a[href="/installation-other"]');

describe("the update dot in the sidebar", () => {
  it.each(["owner", "read_only"] as const)(
    "shows it to a provider administrator (%s) beside the version and on the installation entry",
    async (providerRole) => {
      await render({ kind: "provider", providerRole }, AVAILABLE);

      const link = footerLink();
      expect(link?.textContent).toBe("Version 0.4.8");
      expect(link?.getAttribute("href")).toBe("/installation/updates");
      expect(link?.getAttribute("title")).toBe("Update to 0.4.9 available");
      expect(link?.getAttribute("aria-label")).toBe("Version 0.4.8, Update to 0.4.9 available");
      expect(link?.querySelector('[data-slot="update-dot"]')).not.toBeNull();

      const entry = installationEntry();
      expect(entry?.querySelector('[data-slot="update-dot"]')).not.toBeNull();
      // The dot is drawn only; the entry's name carries the words.
      expect(entry?.textContent).toContain("Update to 0.4.9 available");
      expect(entry?.querySelector(".sr-only")?.textContent).toBe(", Update to 0.4.9 available");
      // Only the entry that leads to Updates, not its neighbours.
      expect(otherEntry()?.querySelector('[data-slot="update-dot"]')).toBeNull();
      expect(dots()).toHaveLength(2);
    },
  );

  it("is the accent colour, never green, and pulses only where motion is allowed", async () => {
    await render({ kind: "provider", providerRole: "owner" }, AVAILABLE);
    expect(dots().length).toBeGreaterThan(0);
    for (const dot of dots()) {
      const classes = dot.className;
      expect(classes).toContain("bg-info");
      expect(classes).not.toMatch(/success|green|emerald/);
      expect(classes).toContain("motion-safe:animate-update-pulse");
      expect(classes).not.toMatch(/(^|\s)animate-/);
      expect(dot.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("shows nothing to a tenant administrator, who has no Updates section", async () => {
    await render({ kind: "tenant" }, AVAILABLE);
    expect(dots()).toEqual([]);
    expect(footerLink()).toBeNull();
    expect(installationEntry()).toBeNull();
    // The plain version and the notice that existed before stay.
    expect(document.body.textContent).toContain("Version 0.4.8");
  });

  it("shows nothing while the installation is up to date or the check is off", async () => {
    await render(
      { kind: "provider", providerRole: "owner" },
      { ...AVAILABLE, latest: "0.4.8", updateAvailable: false },
    );
    expect(dots()).toEqual([]);
    expect(footerLink()).toBeNull();
    expect(document.body.textContent).toContain("Version 0.4.8");
    expect(installationEntry()?.textContent).not.toContain("Update to");
  });
});
