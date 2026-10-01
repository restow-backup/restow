import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  BellRing,
  Building2,
  History,
  LayoutDashboard,
  ListChecks,
  MailSearch,
} from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { PageHeader } from "@/components/page-header";
import { ThemeProvider } from "@/components/theme-provider";
import { i18n } from "@/i18n";
import { type Me, type SetupState, queryKeys } from "@/lib/api";
import { applyProductName } from "@/lib/branding";
import { registerWebExtension, resetWebExtensionsForTesting } from "@/lib/extensions";
import type { NavItem, NavLock } from "@/lib/navigation";
import { type SessionContextValue, StaticSessionProvider, resolveTenantView } from "@/lib/session";
import { NotFoundPage } from "@/routes/not-found";
import { appLayoutRoute, rootRoute } from "@/routes/tree";

/**
 * The shell rendered to static markup through the real route tree (root
 * guard, shell guard, error and not-found handling) with a memory history:
 * what a visitor gets for a page, a failing page and an unknown address.
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// The root guard applies the installation's product name to the shared i18n instance.
afterEach(() => {
  applyProductName(undefined);
  resetWebExtensionsForTesting();
});

const OPERATOR_ROLES = ["provider_admin", "tenant_admin"];

/** A lock as an extension supplies it: closed unless the profile carries `unlocked: true`. */
const reportLock: NavLock = {
  isLocked: (context) => context.extensions?.unlocked !== true,
  to: "/settings",
  search: { section: "about", requires: "reports" },
  hintKey: "common:errors.featureUnavailable",
};

const navItems: NavItem[] = [
  {
    id: "dashboard",
    path: "/",
    labelKey: "dashboard:nav",
    icon: LayoutDashboard,
    group: "daily",
    exact: true,
  },
  {
    id: "history",
    path: "/history",
    labelKey: "backup:nav.history",
    icon: History,
    group: "daily",
    roles: OPERATOR_ROLES,
  },
  {
    id: "alerts",
    path: "/alerts",
    labelKey: "reports:nav",
    icon: BellRing,
    group: "daily",
    lock: reportLock,
  },
  {
    id: "mail-jobs",
    path: "/jobs",
    search: { type: "mail" },
    labelKey: "nav.items.jobs",
    icon: ListChecks,
    group: "mail",
    roles: OPERATOR_ROLES,
    soon: "0.2.0",
  },
  {
    id: "restore",
    path: "/restore",
    labelKey: "restore:nav.explorer",
    icon: MailSearch,
    group: "mail",
  },
  {
    id: "tenant-setup",
    path: "/protected-objects",
    matches: ["/sources", "/schedules"],
    labelKey: "nav.items.setup",
    icon: Building2,
    group: "tenants",
    roles: OPERATOR_ROLES,
  },
];

const pages = [
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/",
    component: () => <PageHeader title="Overview" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/history",
    component: () => <PageHeader title="History" description="Every run." />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/history/$jobId",
    component: () => <PageHeader title="Weekly mail backup" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/jobs",
    component: () => <PageHeader title="Jobs" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/protected-objects",
    component: () => <PageHeader title="Protected objects" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/restore",
    component: () => <PageHeader title="Restore" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/sources",
    component: () => <PageHeader title="Sources" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/sources/$sourceId",
    component: () => <PageHeader title="Contoso M365" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/broken",
    loader: () => {
      throw new Error("Widget exploded");
    },
    component: () => <p>never shown</p>,
  }),
  createRoute({ getParentRoute: () => appLayoutRoute, path: "$", component: NotFoundPage }),
];

const routeTree = rootRoute.addChildren([appLayoutRoute.addChildren(pages)]);

const me: Me = {
  user: { id: "u1", name: "Alex Example", email: "alex@example.test" },
  role: "tenant_admin",
  tenants: [
    { id: "contoso", name: "Contoso", slug: "contoso", role: "tenant_admin" },
    { id: "fabrikam", name: "Fabrikam", slug: "fabrikam", role: "tenant_user" },
  ],
  activeTenantId: null,
  features: [],
  extensions: {},
};

const setupState: SetupState = {
  configured: true,
  productName: "Restow",
  operatingMode: "public",
  publicUrl: "https://restow.example.test",
  passkeyReady: { ready: true, reasons: [], rpId: "restow.example.test", origin: null },
  mailTransport: "smtp",
  disclaimer: { version: "2026-09-30", accepted: true },
  setupToken: { required: false, source: null },
  microsoftSignIn: false,
  demo: { enabled: false, email: null, password: null },
};

function sessionFor(activeTenantId: string): SessionContextValue {
  const view = resolveTenantView(me, undefined, [activeTenantId]);
  return {
    status: "authenticated",
    user: me.user,
    role: view.role,
    features: me.features,
    extensions: me.extensions,
    isProviderAdmin: view.isProviderAdmin,
    tenants: view.tenants,
    activeTenant: view.activeTenant,
    setActiveTenant: () => {},
    version: {
      running: "0.301.0",
      commit: "4f2a9c1",
      latest: null,
      updateAvailable: false,
      releaseUrl: null,
    },
    signOut: async () => {},
    refresh: async () => {},
    error: null,
  };
}

async function renderShell(
  path: string,
  activeTenantId = "contoso",
  setupStateOverride: SetupState = setupState,
  sessionOverride: Partial<SessionContextValue> = {},
): Promise<string> {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.setupState, setupStateOverride);
  queryClient.setQueryData(queryKeys.authSession, {
    session: { id: "s1", userId: "u1", authMethod: "passkey" },
    user: { id: "u1", name: me.user.name, email: me.user.email, twoFactorEnabled: true },
  });
  queryClient.setQueryData(queryKeys.me, me);

  const router = createRouter({
    routeTree,
    context: { queryClient, navItems },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();

  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <StaticSessionProvider value={{ ...sessionFor(activeTenantId), ...sessionOverride }}>
            <RouterProvider router={router} />
          </StaticSessionProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );
}

/** Opening tags of the elements that take keyboard focus by default, in document order. */
function focusableTags(html: string): string[] {
  return [...html.matchAll(/<(?:a|button|input|select|textarea)\b[^>]*>|<[^>]+tabindex="0"[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => !/\sdisabled(?:=|\s|>)/.test(tag) && !/tabindex="-1"/.test(tag));
}

describe("application shell", () => {
  it("names the product the installation is branded with, from the public setup state", async () => {
    const branded = await renderShell("/history", "contoso", {
      ...setupState,
      productName: "Acme Backup",
    });
    expect(branded).toContain("Acme Backup");
    expect(branded).not.toContain("Restow");
    applyProductName(undefined);
    const standard = await renderShell("/history");
    expect(standard).toContain("Restow");
  });

  it("renders a page inside the shell with its nav icon and breadcrumbs", async () => {
    const html = await renderShell("/history");
    // Sidebar, top bar and palette trigger around the page.
    expect(html).toContain('data-slot="sidebar"');
    expect(html).toContain('aria-label="Search pages and actions"');
    expect(html).toContain("Contoso");
    // The page header borrows the icon of its menu entry.
    expect(html).toMatch(/data-slot="page-header".*lucide-history/s);
    // Section > entry, the entry being the current page.
    expect(html).toMatch(
      /<nav aria-label="Breadcrumb"[^>]*>.*Daily.*aria-current="page"[^>]*>History</s,
    );
    // The sidebar footer shows the running version, and no edition of its own.
    expect(html).toContain("Version 0.301.0");
    expect(html).not.toMatch(/Community|Business|Service Provider/);
  });

  it("links the menu entry from a detail page", async () => {
    const html = await renderShell("/history/7");
    expect(html).toMatch(/<nav aria-label="Breadcrumb".*href="\/history"[^>]*>History<\/a>/s);
    expect(html).toContain("Weekly mail backup");
    // A real, styled link: underline on hover and a visible focus ring, never
    // a plain-text lookalike. (The page's own title only reaches the
    // breadcrumb through an effect — `usePublishedTitle` — which a static
    // render never runs, so the third "current page" crumb this route would
    // show live is not observable here; see breadcrumb-trail.test.ts for
    // that half of the contract, on the pure trail builder.)
    const crumb = html.match(/<a[^>]*href="\/history"[^>]*>History<\/a>/s)?.[0];
    expect(crumb).toBeTruthy();
    expect(crumb).toContain("hover:underline");
    expect(crumb).toContain("focus-visible:ring-[3px]");
  });

  it("reads Tenants › Setup › <tab> on a page of the tenant setup area, with its tab bar", async () => {
    const tab = await renderShell("/protected-objects");
    const crumbs = tab.match(/<nav aria-label="Breadcrumb".*?<\/nav>/s)?.[0] ?? "";
    expect(crumbs).toMatch(
      /Tenants.*href="\/protected-objects"[^>]*>Setup<\/a>.*aria-current="page"[^>]*>Protection</s,
    );
    // The shared tab bar of the area, the current tab marked.
    const bar = tab.match(/<nav aria-label="Setup of Contoso"[^>]*>.*?<\/nav>/s)?.[0] ?? "";
    const current = bar.match(/<a[^>]*aria-current="page"[^>]*>/g) ?? [];
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/protected-objects"');
    for (const path of ["/sources", "/schedules", "/retention", "/imports"]) {
      expect(bar).toContain(`href="${path}"`);
    }
    // The sidebar highlights Setup.
    const sidebarEntry = tab.match(
      /<a[^>]*data-sidebar="menu-button"[^>]*>(?:(?!<\/a>).)*Setup<\/span><\/a>/s,
    )?.[0];
    expect(sidebarEntry).toContain('aria-current="page"');
    expect(sidebarEntry).toContain('href="/protected-objects"');

    // Below a tab: the tab links back, no tab bar.
    const detail = await renderShell("/sources/src-1");
    expect(detail).toMatch(/<nav aria-label="Breadcrumb".*href="\/sources"[^>]*>Sources<\/a>/s);
    expect(detail).toContain("Contoso M365");
    expect(detail).not.toContain('aria-label="Setup of Contoso"');
  });

  it("makes the group crumb a menu button listing its section's entries, never a link", async () => {
    const html = await renderShell("/history");
    expect(html).not.toMatch(/<a[^>]*>Daily<\/a>/);
    const trigger = html.match(/<button[^>]*data-slot="breadcrumb-group"[^>]*>.*?<\/button>/s)?.[0];
    expect(trigger).toBeTruthy();
    expect(trigger).toContain('aria-haspopup="menu"');
    expect(trigger).toContain('aria-expanded="false"');
    // The name starts with the visible label (WCAG 2.5.3).
    expect(trigger).toContain('aria-label="Daily, show entries"');
    expect(trigger).toContain(">Daily<");
  });

  it("marks an upcoming entry Soon in words, not by colour alone, and names it for screen readers", async () => {
    const html = await renderShell("/history");
    const entry = html.match(/<a[^>]*data-soon="true"[^>]*>.*?<\/a>/s)?.[0];
    expect(entry).toBeTruthy();
    expect(entry).toContain('href="/jobs?type=mail"');
    // "Jobs, coming soon" for assistive technology, "Soon" on screen.
    expect(entry).toMatch(/Jobs<span class="sr-only">, coming soon<\/span>/);
    const badge = entry?.match(/<span[^>]*data-slot="soon-badge"[^>]*>Soon<\/span>/)?.[0];
    expect(badge).toContain('aria-hidden="true"');
    // Amber warning tone, never green.
    expect(entry).toContain("bg-warning/20");
    expect(entry).toContain("text-warning-text");
    expect(entry).not.toMatch(/success/);
  });

  it("highlights the upcoming entry on its placeholder page by its search params", async () => {
    const html = await renderShell("/jobs?type=mail");
    const current =
      html.match(
        /<a[^>]*data-sidebar="menu-button"[^>]*aria-current="page"[^>]*>|<a[^>]*aria-current="page"[^>]*data-sidebar="menu-button"[^>]*>/g,
      ) ?? [];
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/jobs?type=mail"');
    expect(html).toMatch(
      /<nav aria-label="Breadcrumb"[^>]*>.*Mail &amp; SaaS.*aria-current="page"[^>]*>Jobs</s,
    );
  });

  it("keeps sign-in security out of the sidebar (it is in the user menu)", async () => {
    const html = await renderShell("/history");
    expect(html).not.toContain('href="/account"');
  });

  it("offers exactly one sidebar collapse control, in the top bar", async () => {
    const html = await renderShell("/history");
    // The trigger (top bar, `data-sidebar="trigger"`) and the rail (edge of
    // the sidebar itself, `data-sidebar="rail"`) toggle the same state and
    // are the only two controls; expanded and collapsed share this exact
    // markup (only CSS classes driven by `data-state` differ), so there is
    // no separate "top right when expanded, bottom left when collapsed"
    // control to regress to.
    expect(html.match(/data-sidebar="trigger"/g)).toHaveLength(1);
    expect(html.match(/data-sidebar="rail"/g)).toHaveLength(1);
    expect(html).toContain('aria-keyshortcuts="Control+B Meta+B"');
  });

  it("makes the skip link the first focusable element, targeting #main", async () => {
    const html = await renderShell("/history");
    const [first] = focusableTags(html);
    expect(first).toContain('data-slot="skip-link"');
    expect(first).toContain('href="#main"');
    expect(html).toContain('<main id="main" tabindex="-1"');
    expect(html).toContain("Skip to content");
  });

  it("renders a failing route inside the shell with the cause, a retry and the way back", async () => {
    const html = await renderShell("/broken");
    expect(html).toContain('data-slot="sidebar"');
    expect(html).toContain("This page could not be displayed");
    expect(html).toContain("The action could not be completed. Please try again.");
    expect(html).toMatch(/<button[^>]*>.*Retry<\/button>/s);
    expect(html).toContain("Back to overview");
    expect(html).toContain("Technical details");
    expect(html).not.toContain("never shown");
  });

  it("answers an unknown address with the not-found page inside the shell", async () => {
    const html = await renderShell("/no/such/page");
    expect(html).toContain('data-slot="sidebar"');
    expect(html).toContain("Page not found");
    expect(html).toContain("/no/such/page");
  });

  it("gates the navigation by the role in the active tenant (review finding 7)", async () => {
    const asAdmin = await renderShell("/restore", "contoso");
    expect(asAdmin).toMatch(/data-slot="sidebar".*href="\/history"/s);

    const asUser = await renderShell("/restore", "fabrikam");
    expect(asUser).toContain('href="/restore"');
    expect(asUser).not.toContain('href="/history"');
    expect(asUser).not.toContain('href="/jobs?type=mail"');
    expect(asUser).toContain("Fabrikam");
  });

  it("shows no demo banner for a normal installation", async () => {
    const html = await renderShell("/history");
    expect(html).not.toContain("all data resets every night");
  });

  it("shows the demo banner above every page in demo mode (deploy/demo)", async () => {
    const html = await renderShell("/history", "contoso", {
      ...setupState,
      demo: { enabled: true, email: "demo@example.org", password: "x" },
    });
    expect(html).toContain("all data resets every night at 03:00");
  });

  it("renders a locked entry generically: greyed out, with a lock, leading where the lock says", async () => {
    const html = await renderShell("/history");
    const entry = html.match(/<a[^>]*data-locked="true"[^>]*>.*?<\/a>/s)?.[0];
    expect(entry).toBeTruthy();
    expect(entry).toContain('href="/settings?section=about&amp;requires=reports"');
    expect(entry).toContain('aria-disabled="true"');
    expect(entry).toContain("lucide-lock");
    expect(entry).toContain("Alerts");
    expect(html).toContain("text-sidebar-foreground/50");
    expect(html).not.toContain('href="/alerts"');
  });

  it("renders the same entry as a plain link once its lock opens", async () => {
    const html = await renderShell("/history", "contoso", setupState, {
      extensions: { unlocked: true },
    });
    expect(html).toMatch(/<a[^>]*href="\/alerts"[^>]*>/);
    expect(html).not.toContain('data-locked="true"');
  });

  it("keeps an entry locked while the profile is loading", async () => {
    const html = await renderShell("/history", "contoso", setupState, {
      features: null,
      extensions: null,
    });
    expect(html).toContain('data-locked="true"');
  });

  it("renders what an extension adds to the sidebar footer, and nothing without one", async () => {
    expect(await renderShell("/history")).not.toContain("footer-extension");
    registerWebExtension({
      name: "footer-test",
      slots: { "shell.sidebarFooter": () => <span data-slot="footer-extension">Footer note</span> },
    });
    const html = await renderShell("/history");
    expect(html).toMatch(/data-slot="footer-extension"[^>]*>Footer note</);
    expect(html).toContain("Version 0.301.0");
  });
});
