// @vitest-environment happy-dom
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { BellRing, History, LayoutDashboard, ScrollText } from "lucide-react";
import type * as React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GroupCrumbMenu } from "@/components/layout/shell-breadcrumbs";
import { OverviewTabs } from "@/features/dashboard/components/overview-tabs";
import { i18n } from "@/i18n";
import type { PlacedNavItem } from "@/lib/navigation";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";

/**
 * The navigation pieces of the final menu in a real DOM: the group crumb's
 * menu (keyboard), the tab bar of the tenant setup area and the tabs of
 * Overview, each inside a router so their links resolve.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

function session(role: SessionContextValue["role"]): SessionContextValue {
  const tenant = {
    id: "contoso",
    name: "Contoso",
    slug: "contoso",
    kind: "customer" as const,
    customerNumber: null,
    role: "tenant_admin" as const,
  };
  return {
    status: "authenticated",
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role,
    features: [],
    extensions: {},
    isProviderAdmin: role === "provider_admin",
    tenants: [{ ...tenant, status: "active" }],
    activeTenant: { ...tenant, status: "active" },
    setActiveTenant: () => {},
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
  } as SessionContextValue;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Mount `node` as the page at `path` of a bare router. */
async function render(
  path: string,
  node: React.ReactNode,
  role: SessionContextValue["role"] = "tenant_admin",
) {
  const rootRoute = createRootRoute({ component: () => <>{node}</> });
  const page = (p: string) =>
    createRoute({ getParentRoute: () => rootRoute, path: p, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ["/", "/history", "/schedules", "/sources/$id", "/protected-objects"].map(page),
    ),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <StaticSessionProvider value={session(role)}>
          <RouterProvider router={router} />
        </StaticSessionProvider>
      </I18nextProvider>,
    );
    await tick();
  });
}

async function key(target: Element, name: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    await tick();
  });
}

const DAILY: PlacedNavItem[] = [
  { id: "dashboard", path: "/", labelKey: "dashboard:nav", icon: LayoutDashboard, locked: false },
  { id: "history", path: "/history", labelKey: "backup:nav.history", icon: History, locked: false },
  {
    id: "alerts",
    path: "/alerts",
    labelKey: "reports:nav",
    icon: BellRing,
    locked: false,
    soon: "0.2.0",
  },
  {
    id: "audit",
    path: "/audit",
    labelKey: "audit:nav",
    icon: ScrollText,
    locked: true,
    lock: { isLocked: () => true, to: "/settings", hintKey: "common:errors.featureUnavailable" },
  },
];

describe("the group crumb's menu", () => {
  it("opens with Enter, moves with the arrows, marks the current entry and closes with Escape", async () => {
    await render("/history", <GroupCrumbMenu label="Daily" items={DAILY} activeId="history" />);
    const trigger = document.querySelector<HTMLButtonElement>('[data-slot="breadcrumb-group"]');
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger?.getAttribute("aria-label")).toBe("Daily, show entries");
    trigger?.focus();

    await key(trigger as Element, "Enter");
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const entries = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
    expect(entries.map((entry) => entry.getAttribute("href"))).toEqual([
      "/",
      "/history",
      "/alerts",
      "/settings",
    ]);
    // The page the visitor is on, an upcoming entry and a locked one.
    expect(entries[1]?.getAttribute("aria-current")).toBe("page");
    expect(entries[2]?.textContent).toContain("coming soon");
    expect(entries[2]?.querySelector('[data-slot="soon-badge"]')?.textContent).toBe("Soon");
    expect(entries[3]?.getAttribute("data-locked")).toBe("true");

    const first = document.activeElement;
    expect(entries).toContain(first);
    await key(first as Element, "ArrowDown");
    expect(document.activeElement).not.toBe(first);
    expect(entries).toContain(document.activeElement);

    await key(document.activeElement as Element, "Escape");
    // The menu leaves after its exit; focus goes back to the crumb.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the trigger as the scope pill when the group is named like the scope", async () => {
    await render(
      "/history",
      <GroupCrumbMenu label="Installation" items={DAILY} activeId="history" scope="installation" />,
    );
    const trigger = document.querySelector<HTMLButtonElement>('[data-slot="breadcrumb-group"]');
    // One button: the menu trigger, whose face is the pill (icon, text, chevron).
    const pill = trigger?.querySelector('[data-slot="scope-pill"]');
    expect(pill?.getAttribute("data-scope")).toBe("installation");
    expect(pill?.textContent).toBe("Installation");
    expect(trigger?.getAttribute("aria-label")).toBe("Installation, show entries");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
    trigger?.focus();
    await key(trigger as Element, "Enter");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await key(document.activeElement as Element, "Escape");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("opens with Space as well", async () => {
    await render("/history", <GroupCrumbMenu label="Daily" items={DAILY} activeId="history" />);
    const trigger = document.querySelector<HTMLButtonElement>('[data-slot="breadcrumb-group"]');
    trigger?.focus();
    await key(trigger as Element, " ");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });
});

describe("the tabs of Overview", () => {
  it("offers Status and Statistics to administrators, the current one marked", async () => {
    await render("/?view=statistics", <OverviewTabs current="statistics" />);
    const bar = document.querySelector('nav[aria-label="Overview views"]');
    const links = [...(bar?.querySelectorAll("a") ?? [])];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Status", "/"],
      ["Statistics", "/?view=statistics"],
    ]);
    // Exactly one current tab, though both tabs share the path.
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, "page"]);
  });

  it("shows no tabs to an end user, who has no statistics", async () => {
    await render("/", <OverviewTabs current="status" />, "tenant_user");
    expect(document.querySelector('nav[aria-label="Overview views"]')).toBeNull();
  });
});
