import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import {
  BellRing,
  Building2,
  Gauge,
  History,
  LayoutDashboard,
  ListChecks,
  MailSearch,
  Settings,
} from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { PageHeader } from "@/components/page-header";
import { ThemeProvider } from "@/components/theme-provider";
import { dashboardKeys } from "@/features/dashboard/api";
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
  to: "/installation/license",
  search: { requires: "reports" },
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
    id: "verify",
    path: "/verify",
    labelKey: "verify:nav",
    icon: Gauge,
    group: "daily",
    roles: OPERATOR_ROLES,
  },
  {
    id: "tenant-settings",
    path: "/tenants/$activeTenant/overview",
    matches: ["/tenants/$activeTenant"],
    labelKey: "nav.items.tenantSettings",
    icon: Settings,
    group: "tenants",
    roles: OPERATOR_ROLES,
    visible: (context) => (context.features ?? []).includes("tenants.additional"),
  },
  {
    id: "organisation-settings",
    path: "/tenants/$activeTenant/overview",
    matches: ["/tenants/$activeTenant"],
    labelKey: "nav.items.organisationSettings",
    icon: Settings,
    group: "tenants",
    roles: OPERATOR_ROLES,
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
  {
    id: "settings",
    path: "/installation",
    labelKey: "installation:nav",
    icon: Settings,
    group: "installation",
    roles: ["provider_admin"],
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
  // The tenant page: the title is the section the address names.
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/tenants/$tenantId/$section",
    component: function TenantSection() {
      const { section } = useParams({ strict: false }) as { section: string };
      return <PageHeader title={section.charAt(0).toUpperCase() + section.slice(1)} />;
    },
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/restore",
    component: () => <PageHeader title="Restore" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/verify",
    component: () => <PageHeader title="Recovery readiness" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/tenants/$tenantId/connections/sources/$sourceId",
    component: () => <PageHeader title="Connections" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/broken",
    loader: () => {
      throw new Error("Widget exploded");
    },
    component: () => <p>never shown</p>,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/tenants",
    component: () => <PageHeader title="All tenants" />,
  }),
  createRoute({
    getParentRoute: () => appLayoutRoute,
    path: "/installation",
    component: () => <PageHeader title="Settings" />,
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
  seed: (queryClient: QueryClient) => void = () => {},
): Promise<string> {
  const queryClient = new QueryClient();
  seed(queryClient);
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

/** The setup response the sidebar's Start entry reads (`/dashboard?widgets=setup`). */
function setupWith(overrides: Partial<{ complete: boolean; done: number }> = {}): {
  widgets: { setup: { state: "ok"; data: unknown } };
} {
  const states = ["done", "done", "done", "done", "open", "open", "open"] as const;
  return {
    widgets: {
      setup: {
        state: "ok",
        data: {
          complete: false,
          done: 4,
          total: 7,
          items: [
            "storage",
            "source",
            "objects",
            "schedules",
            "firstBackup",
            "firstVerification",
            "notificationMail",
          ].map((id, index) => ({
            id,
            state: states[index],
            reason: null,
            actionable: true,
          })),
          ...overrides,
        },
      },
    },
  };
}

const SETUP_OPEN = setupWith();

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
    // Scope > section > entry, the entry being the current page.
    expect(html).toMatch(
      /<nav aria-label="Breadcrumb"[^>]*>.*Organisation: Contoso.*Daily.*aria-current="page"[^>]*>History</s,
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

  it("reads Organisation (the pill, with the section menu) › Settings › <section> on the page of the tenant (the section is the title the page publishes: not observable in a static render)", async () => {
    const page = await renderShell("/tenants/contoso/protection");
    const crumbs = page.match(/<nav aria-label="Breadcrumb".*?<\/nav>/s)?.[0] ?? "";
    // The pill is the organisation's section menu, so no second "Organisation" crumb.
    expect(crumbs).toMatch(
      /data-slot="breadcrumb-group"[^>]*aria-label="Organisation: Contoso, show entries".*href="\/tenants\/contoso"[^>]*>Settings<\/a>/s,
    );
    expect(crumbs.match(/>Organisation</g)).toBeNull();
    // The sidebar highlights the entry: Settings of the one organisation, opening its overview.
    const sidebarEntry = page.match(
      /<a[^>]*data-sidebar="menu-button"[^>]*>(?:(?!<\/a>).)*Settings<\/span><\/a>/s,
    )?.[0];
    expect(sidebarEntry).toContain('aria-current="page"');
    expect(sidebarEntry).toContain('href="/tenants/contoso/overview"');

    // A page below a section keeps the entry highlighted.
    const detail = await renderShell("/tenants/contoso/connections/sources/src-1");
    expect(detail).toMatch(
      /<nav aria-label="Breadcrumb".*href="\/tenants\/contoso"[^>]*>Settings<\/a>/s,
    );
    expect(
      detail.match(
        /<a[^>]*data-sidebar="menu-button"[^>]*>(?:(?!<\/a>).)*Settings<\/span><\/a>/s,
      )?.[0],
    ).toContain('aria-current="page"');
  });

  it("calls the entry Tenant settings, and the scope a tenant, where the installation manages tenants", async () => {
    const html = await renderShell("/tenants/contoso/protection", "contoso", setupState, {
      features: ["tenants.additional"],
    });
    const crumbs = html.match(/<nav aria-label="Breadcrumb".*?<\/nav>/s)?.[0] ?? "";
    expect(crumbs).toMatch(
      /Tenant: Contoso.*Tenants.*href="\/tenants\/contoso"[^>]*>Tenant settings<\/a>/s,
    );
    expect(html).toMatch(/data-sidebar="group-label"[^>]*>Tenants</);
    expect(html).not.toMatch(/data-sidebar="group-label"[^>]*>Organisation</);
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
    expect(entry).toContain('href="/installation/license?requires=reports"');
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

  describe("tenant switcher and scope", () => {
    const own = {
      id: "own",
      name: "IT Systeme Flores",
      slug: "own",
      kind: "internal" as const,
      customerNumber: null,
      role: "tenant_admin" as const,
      status: "active" as const,
    };
    const numbered = {
      id: "mueller",
      name: "Weber & Partner Steuerberatungsgesellschaft mbB",
      slug: "weber",
      kind: "customer" as const,
      customerNumber: "KD-10311",
      role: "tenant_admin" as const,
      status: "active" as const,
    };
    const provider = (active: typeof own | typeof numbered): Partial<SessionContextValue> => ({
      role: "provider_admin",
      isProviderAdmin: true,
      features: ["tenants.additional"],
      tenants: [own, numbered],
      activeTenant: active,
    });

    /** The sidebar and the top bar of the rendered shell, apart. */
    function parts(html: string) {
      const sidebar = html.match(/<div[^>]*data-slot="sidebar"[^>]*>.*?<\/nav>/s)?.[0] ?? "";
      const topBar = html.match(/<header[^>]*>.*?<\/header>/s)?.[0] ?? "";
      return { sidebar, topBar };
    }

    it("puts the switcher in the sidebar below the wordmark and above the first section, not in the top bar", async () => {
      const { sidebar, topBar } = parts(await renderShell("/history"));
      expect(topBar).not.toContain("tenant-switcher");
      expect(topBar).not.toContain("Switch tenant");
      const wordmark = sidebar.indexOf("Restow");
      const switcher = sidebar.indexOf('data-slot="tenant-switcher"');
      const firstSection = sidebar.indexOf('data-sidebar="group-label"');
      expect(wordmark).toBeGreaterThan(-1);
      expect(switcher).toBeGreaterThan(wordmark);
      expect(firstSection).toBeGreaterThan(switcher);
      // The trigger names the active tenant and the way to the dropdown.
      expect(sidebar).toMatch(/<button[^>]*aria-label="Switch tenant, current: Contoso"/);
    });

    it("shows the customer number in mono as the trigger's second line, 'Internal' for the own organisation", async () => {
      const customer = parts(
        await renderShell("/history", "contoso", setupState, provider(numbered)),
      );
      expect(customer.sidebar).toContain("Weber &amp; Partner Steuerberatungsgesellschaft mbB");
      expect(customer.sidebar).toMatch(
        /font-mono[^>]*>(?:<span class="sr-only">Customer number <\/span>)?KD-10311</,
      );
      const internal = parts(await renderShell("/history", "contoso", setupState, provider(own)));
      expect(internal.sidebar).toMatch(/data-slot="tenant-subline"[^>]*>.*Internal/s);
    });

    it("gives the trigger the full name as its title and keeps one line for it", async () => {
      const { sidebar } = parts(
        await renderShell("/history", "contoso", setupState, provider(numbered)),
      );
      const trigger = sidebar.match(/<button[^>]*data-slot="tenant-switcher-trigger"[^>]*>/)?.[0];
      expect(trigger).toContain('title="Weber &amp; Partner Steuerberatungsgesellschaft mbB"');
      expect(trigger).toContain("h-12");
      expect(sidebar).toMatch(/data-slot="tenant-name" class="[^"]*truncate/);
    });

    it("opens the settings of the active tenant from the gear, the same page as the menu entry", async () => {
      const html = await renderShell("/history", "contoso", setupState, provider(numbered));
      const gear = html.match(/<a[^>]*data-slot="tenant-settings-link"[^>]*>/)?.[0];
      expect(gear).toContain(`href="/tenants/${numbered.id}/overview"`);
      expect(gear).toContain(
        'aria-label="Open settings of Weber &amp; Partner Steuerberatungsgesellschaft mbB"',
      );
      const entry = html.match(
        /<a[^>]*data-sidebar="menu-button"[^>]*>(?:(?!<\/a>).)*Tenant settings<\/span><\/a>/s,
      )?.[0];
      expect(entry).toContain(`href="/tenants/${numbered.id}/overview"`);
    });

    it("offers a tenant admin of a Service Provider installation the gear and the entry too", async () => {
      const html = await renderShell("/history", "contoso", setupState, {
        features: ["tenants.additional"],
      });
      expect(html).toMatch(/data-slot="tenant-settings-link"/);
      expect(html).toMatch(/Tenant settings<\/span>/);
      expect(html).not.toContain('href="/tenants"');
    });

    it("shows no gear to an end user, who has no settings entry", async () => {
      const html = await renderShell("/restore", "fabrikam");
      expect(html).not.toContain('data-slot="tenant-settings-link"');
      expect(html).not.toContain('href="/tenants/fabrikam/overview"');
    });

    it("shows the name statically, with the gear, in an installation with one tenant", async () => {
      const ownOrganisation = { ...own, kind: "internal" as const };
      const single = {
        tenants: [ownOrganisation],
        activeTenant: ownOrganisation,
        features: [],
      } satisfies Partial<SessionContextValue>;
      const { sidebar } = parts(await renderShell("/history", "contoso", setupState, single));
      expect(sidebar).toContain('data-slot="tenant-switcher-static"');
      expect(sidebar).not.toContain('data-slot="tenant-switcher-trigger"');
      expect(sidebar).not.toMatch(/aria-haspopup/);
      expect(sidebar).toContain('data-slot="tenant-settings-link"');
      // One organisation: "Organisation", never "Internal" or "Tenant".
      expect(sidebar).toMatch(/data-slot="tenant-subline"[^>]*>.*Organisation/s);
      expect(sidebar).not.toMatch(
        /data-slot="tenant-subline"[^>]*>[^<]*<span[^>]*>(Internal|Tenant)</,
      );
    });

    it("names the scope in the header: a tenant, the own organisation, the installation, all tenants", async () => {
      const crumbs = (html: string) =>
        html.match(/<nav aria-label="Breadcrumb".*?<\/nav>/s)?.[0] ?? "";
      expect(
        crumbs(await renderShell("/history", "contoso", setupState, provider(numbered))),
      ).toMatch(
        /data-scope="tenant"[^>]*>.*Tenant: Weber &amp; Partner Steuerberatungsgesellschaft mbB/s,
      );
      expect(crumbs(await renderShell("/history", "contoso", setupState, provider(own)))).toMatch(
        /data-scope="internal"[^>]*>.*Own organisation · internal/s,
      );
      const installation = crumbs(
        await renderShell("/installation", "contoso", setupState, provider(numbered)),
      );
      // The pill is the menu of its section, named like it: no second "Installation" crumb.
      expect(installation).toMatch(
        /<button[^>]*data-slot="breadcrumb-group"[^>]*aria-label="Installation, show entries"/,
      );
      expect(installation).toContain('data-scope="installation"');
      expect(installation.match(/>Installation</g)).toHaveLength(1);
      expect(installation).toMatch(/aria-current="page"[^>]*>Settings</);
      // The list of all tenants works on all of them; its menu entry is "Manage tenants" so that
      // the name "All tenants" is the scope's alone.
      const all = crumbs(await renderShell("/tenants", "contoso", setupState, provider(numbered)));
      expect(all).toMatch(
        /data-scope="all"[^>]*>.*All tenants.*aria-current="page"[^>]*>Manage tenants</s,
      );
      expect(all.match(/>All tenants</g)).toHaveLength(1);
    });

    it("never says All tenants to a tenant admin on a page that is not their tenant's", async () => {
      // A tenant admin opens the address of another tenant: "this is not your tenant". The page
      // resolves to the tenant settings entry, and the header names their own level.
      const html = await renderShell("/tenants/fabrikam/overview", "contoso", setupState, {
        features: ["tenants.additional"],
      });
      const crumbs = html.match(/<nav aria-label="Breadcrumb".*?<\/nav>/s)?.[0] ?? "";
      expect(crumbs).toMatch(/data-scope="tenant"[^>]*>.*Tenant: Contoso/s);
      expect(crumbs).not.toContain("All tenants");
      expect(crumbs).not.toContain('data-scope="all"');
      expect(crumbs).not.toContain("Manage tenants");
      // Also in a one-organisation installation, where their level is the organisation.
      const organisation = await renderShell("/tenants/fabrikam/overview");
      const organisationCrumbs =
        organisation.match(/<nav aria-label="Breadcrumb".*?<\/nav>/s)?.[0] ?? "";
      expect(organisationCrumbs).toMatch(/data-scope="organisation"[^>]*>.*Organisation: Contoso/s);
      expect(organisationCrumbs).not.toContain("All tenants");
    });

    it("names no scope on a page outside the menu", async () => {
      const html = await renderShell("/no/such/page");
      expect(html).not.toContain('data-slot="scope-pill"');
    });
  });

  describe("under All tenants", () => {
    const ownOrg = {
      id: "own",
      name: "IT Systeme Flores",
      slug: "own",
      kind: "internal" as const,
      customerNumber: null,
      role: "tenant_admin" as const,
      status: "active" as const,
    };
    const customer = {
      id: "mueller",
      name: "Müller GmbH",
      slug: "mueller",
      kind: "customer" as const,
      customerNumber: "KD-10234",
      role: "tenant_admin" as const,
      status: "active" as const,
    };
    const allTenants: Partial<SessionContextValue> = {
      role: "provider_admin",
      isProviderAdmin: true,
      features: ["tenants.additional", "dashboard.allTenants"],
      tenants: [ownOrg, customer],
      activeTenant: customer,
      scope: "all",
      canViewAllTenants: true,
    };
    const crumbs = (html: string) =>
      html.match(/<nav aria-label="Breadcrumb".*?<\/nav>/s)?.[0] ?? "";
    /** The sidebar button whose text starts with `label` (a link of the menu, whatever its tags). */
    const entryOf = (html: string, label: string) =>
      [...html.matchAll(/<a[^>]*data-sidebar="menu-button"[^>]*>.*?<\/a>/gs)]
        .map((match) => match[0])
        .find((entry) => entry.replace(/<[^>]+>/g, "").startsWith(label)) ?? "";

    it("names the level in the header: All tenants, on the overview and on a page that needs a tenant", async () => {
      expect(crumbs(await renderShell("/", "mueller", setupState, allTenants))).toMatch(
        /data-scope="all"[^>]*>.*All tenants/s,
      );
      expect(crumbs(await renderShell("/restore", "mueller", setupState, allTenants))).toMatch(
        /data-scope="all"[^>]*>.*All tenants/s,
      );
      // Installation pages stay on the installation's level.
      expect(
        crumbs(await renderShell("/installation", "mueller", setupState, allTenants)),
      ).toContain('data-scope="installation"');
    });

    it("dims the entries that only exist per tenant, with the reason, and leaves the others alone", async () => {
      const html = await renderShell("/", "mueller", setupState, allTenants);
      for (const label of ["History", "Restore", "Jobs"]) {
        const entry = entryOf(html, label);
        expect(entry, label).toContain('data-scope-dimmed="true"');
        expect(entry, label).toContain("text-sidebar-foreground/50");
        expect(entry, label).toContain(
          "Works per tenant: choose a tenant at the top of the menu first.",
        );
      }
      // They stay links: opened, they ask for a tenant.
      expect(entryOf(html, "History")).toContain('href="/history"');
      for (const label of ["Overview", "Recovery readiness", "Manage tenants", "Settings"]) {
        expect(entryOf(html, label), label).not.toContain("data-scope-dimmed");
      }
      // Tenant settings has no tenant to open: it leads to the list, like before a tenant is known.
      const settings = entryOf(html, "Tenant settings");
      expect(settings).toContain('data-scope-dimmed="true"');
      expect(settings).toContain('href="/tenants"');
    });

    it("dims nothing when the session works on one tenant", async () => {
      const html = await renderShell("/", "mueller", setupState, {
        ...allTenants,
        scope: "tenant",
      });
      expect(html).not.toContain("data-scope-dimmed");
    });

    it("shows the choice of a tenant instead of a page that needs one, and not the page", async () => {
      const html = await renderShell("/restore", "mueller", setupState, allTenants);
      expect(html).toContain('data-slot="choose-tenant"');
      expect(html).toContain("This page works on one tenant at a time.");
      // The title is the page's own, the list the tenants: the own organisation first.
      expect(html).toMatch(/data-slot="page-header".*Restore/s);
      expect(html.indexOf("IT Systeme Flores")).toBeLessThan(
        html.indexOf("Müller GmbH", html.indexOf('data-slot="choose-tenant"')),
      );
      expect(html).not.toContain("Restore explorer content");
    });

    it("lets pages that work across tenants open as they are", async () => {
      for (const path of ["/", "/verify", "/tenants", "/installation"]) {
        const html = await renderShell(path, "mueller", setupState, allTenants);
        expect(html, path).not.toContain('data-slot="choose-tenant"');
      }
    });

    it("shows the page itself again once the session works on one tenant", async () => {
      const html = await renderShell("/restore", "mueller", setupState, {
        ...allTenants,
        scope: "tenant",
      });
      expect(html).not.toContain('data-slot="choose-tenant"');
    });

    it("hides Start under All tenants, where there is no one tenant to set up", async () => {
      const html = await renderShell("/", "mueller", setupState, allTenants, (queryClient) =>
        queryClient.setQueryData(dashboardKeys.setup("mueller"), SETUP_OPEN),
      );
      expect(html).not.toContain('data-slot="start"');
    });
  });

  describe("the Start entry", () => {
    it("sits in the sidebar footer above the version, with the progress", async () => {
      const html = await renderShell(
        "/history",
        "contoso",
        setupState,
        { role: "tenant_admin" },
        (queryClient) => queryClient.setQueryData(dashboardKeys.setup("contoso"), SETUP_OPEN),
      );
      const footer = html.match(/data-sidebar="footer".*$/s)?.[0] ?? "";
      expect(footer.indexOf('data-slot="start"')).toBeGreaterThan(-1);
      expect(footer.indexOf('data-slot="start"')).toBeLessThan(footer.indexOf("Version 0.301.0"));
      const start = footer.match(/<div data-slot="start"[^>]*>.*?<\/button>/s)?.[0] ?? "";
      expect(start).toContain('data-done="4"');
      expect(start).toContain("4 of 7 done");
      expect(start).toContain('aria-label="Start, 4 of 7 steps done"');
    });

    it("is not in the menu once every step is done", async () => {
      const html = await renderShell(
        "/history",
        "contoso",
        setupState,
        { role: "tenant_admin" },
        (queryClient) =>
          queryClient.setQueryData(
            dashboardKeys.setup("contoso"),
            setupWith({ complete: true, done: 7 }),
          ),
      );
      expect(html).not.toContain('data-slot="start"');
    });

    it("is never shown to an end user", async () => {
      const html = await renderShell("/restore", "fabrikam", setupState, {}, (queryClient) =>
        queryClient.setQueryData(dashboardKeys.setup("fabrikam"), SETUP_OPEN),
      );
      expect(html).not.toContain('data-slot="start"');
    });

    it("is not shown before the checklist is known, rather than flashing in and out", async () => {
      const html = await renderShell("/history");
      expect(html).not.toContain('data-slot="start"');
    });
  });
});
