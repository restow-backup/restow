import type { QueryClient } from "@tanstack/react-query";
import {
  type AnyRoute,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { vi } from "vitest";

import {
  type Mounted,
  type RecordedRequest,
  json,
  mount,
  newQueryClient,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";
import { queryKeys } from "@/lib/api";
import type { SessionContextValue, SessionTenant } from "@/lib/session";

import { NOW } from "./fixtures.js";
import { createBackupJobRoutes } from "./index.js";

/**
 * A harness for the job page tests (not part of the app bundle: nothing imports
 * this file outside `*.test.*`): the real job routes in a memory router, a session
 * of a tenant administrator, the setup state (public demo or not) and a fetch that
 * answers by `METHOD /path` and records what was asked.
 */

export const TENANT: SessionTenant = {
  id: "tenant-1",
  name: "Müller GmbH",
  slug: "mueller",
  kind: "customer",
  customerNumber: null,
  role: "tenant_admin",
  status: "active",
};

/** A tenant administrator of the active tenant. */
export function adminSession(over: Partial<SessionContextValue> = {}): SessionContextValue {
  return sessionAs({
    role: "tenant_admin",
    isProviderAdmin: false,
    providerRole: null,
    activeTenant: TENANT,
    tenants: [TENANT],
    ...over,
  });
}

/** A provider admin whose team role may only look (technician or read only). */
export function lookerSession(): SessionContextValue {
  return adminSession({
    role: "provider_admin",
    isProviderAdmin: true,
    providerRole: "technician",
    providerAllTenants: true,
  });
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export interface OpenOptions {
  routes?: Record<string, Handler>;
  session?: SessionContextValue;
  queryClient?: QueryClient;
  /** The public demo: every change is closed before a click. */
  demo?: boolean;
}

export interface Opened {
  mounted: Mounted;
  requests: RecordedRequest[];
  /** Where the router is now (path and search). */
  where: () => { pathname: string; search: Record<string, unknown> };
  navigate: (url: string) => Promise<void>;
}

/** The job pages at `url`, in a memory router, mounted into the document. */
export async function openJobs(url: string, options: OpenOptions = {}): Promise<Opened> {
  const { mock, requests } = routedFetch({
    // The next runs the cadence fields preview while a schedule is typed.
    "POST /schedules/preview": () =>
      json({ next: [1, 2, 3, 4, 5].map((day) => new Date(NOW + day * 86_400_000).toISOString()) }),
    "GET /setup/state": () =>
      json({
        configured: true,
        demo: { enabled: options.demo === true, email: null, password: null },
      }),
    ...options.routes,
  });
  vi.stubGlobal("fetch", mock);

  const root = createRootRoute();
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([
      ...createBackupJobRoutes(() => root as unknown as AnyRoute),
      stub("/history"),
      stub("/history/$jobId"),
      stub("/inventory/$endpointId"),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  const queryClient = options.queryClient ?? newQueryClient();
  queryClient.setQueryData(queryKeys.setupState, {
    configured: true,
    demo: { enabled: options.demo === true, email: null, password: null },
  });
  const mounted = mount(<RouterProvider router={router} />, {
    session: options.session ?? adminSession(),
    queryClient,
  });
  return {
    mounted,
    requests,
    where: () => ({
      pathname: router.state.location.pathname,
      search: router.state.location.search as Record<string, unknown>,
    }),
    navigate: async (to) => {
      await router.navigate({ to: to as never });
    },
  };
}

/** The ids an element names with `aria-describedby`, and the text of the elements behind them. */
export function describedText(element: Element): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
}

/** The buttons the page draws in the primary colour (the default variant). */
export function primaryButtons(scope: ParentNode = document.body): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>("button, a")].filter((element) =>
    element.classList.contains("bg-primary"),
  );
}

/** A key pressed on an element the way a browser sends it (it bubbles, so a handler higher up sees it). */
export async function press(
  element: Element | null | undefined,
  key: string,
  init: KeyboardEventInit = {},
): Promise<void> {
  if (!element) {
    throw new Error("press: element not found");
  }
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
    await Promise.resolve();
  });
}

/** Opens the menu of a trigger with the keyboard (Radix opens on a pointer press, which a click does not make). */
export async function openMenu(trigger: Element | null | undefined): Promise<HTMLElement[]> {
  if (!trigger) {
    throw new Error("openMenu: trigger not found");
  }
  await focusOn(trigger);
  await press(trigger, "Enter");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

/** Moves the focus the way a person does, inside `act` so the state a focus handler sets is flushed. */
export async function focusOn(element: Element | null | undefined): Promise<void> {
  if (!element) {
    throw new Error("focusOn: element not found");
  }
  await act(async () => {
    (element as HTMLElement).focus();
    await Promise.resolve();
  });
}
