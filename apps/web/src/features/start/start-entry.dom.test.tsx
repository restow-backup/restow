// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarProvider } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/sonner";
import type { SetupItem, SetupWidget } from "@/features/dashboard/api";
import { routedFetch } from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { type SetupState, setupStateQueryOptions } from "@/lib/api";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";

import { StartEntry } from "./start-entry";

/**
 * The sidebar's Start entry in a real DOM: the ring and the count, the popover
 * with the seven steps and the button on each open one, "Not needed" on the
 * notification mail, and the entry's disappearance (with its one toast) when
 * the last step is done.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

const IDS = [
  "storage",
  "source",
  "objects",
  "schedules",
  "firstBackup",
  "firstVerification",
  "notificationMail",
] as const;

function setupOf(
  states: Partial<Record<(typeof IDS)[number], Partial<SetupItem>>> = {},
  over: Partial<SetupWidget> = {},
): SetupWidget {
  const items: SetupItem[] = IDS.map((id) => ({
    id,
    state: "done",
    reason: null,
    actionable: true,
    ...states[id],
  }));
  const settled = items.filter(
    (entry) => entry.state === "done" || entry.state === "not_needed",
  ).length;
  return { complete: settled === items.length, done: settled, total: items.length, items, ...over };
}

const OPEN = setupOf({
  schedules: { state: "open", reason: "no_backup_schedule" },
  firstBackup: { state: "open" },
  firstVerification: { state: "attention", reason: "not_green" },
  notificationMail: { state: "open", reason: "not_tested" },
});

const setupResponse = (setup: SetupWidget) =>
  new Response(JSON.stringify({ widgets: { setup: { state: "ok", data: setup } } }), {
    headers: { "content-type": "application/json" },
  });

const TENANT = {
  id: "t1",
  name: "Müller GmbH",
  slug: "mueller",
  kind: "customer" as const,
  customerNumber: null,
  role: "tenant_admin" as const,
  status: "active" as const,
};

function session(over: Partial<SessionContextValue> = {}): SessionContextValue {
  return {
    status: "authenticated",
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role: "provider_admin",
    features: ["tenants.additional"],
    extensions: {},
    isProviderAdmin: true,
    providerRole: "owner",
    providerAllTenants: true,
    tenants: [TENANT],
    activeTenant: TENANT,
    setActiveTenant: () => {},
    scope: "tenant",
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let queryClient: QueryClient;

beforeAll(async () => {
  await i18n.changeLanguage("en");
  const proto = Element.prototype as { scrollIntoView?: () => void };
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (times = 4) => {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await tick();
    });
  }
};

async function mountStart(options: {
  session?: SessionContextValue;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  demo?: boolean;
}) {
  vi.stubGlobal("fetch", options.fetch);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(setupStateQueryOptions.queryKey, {
    demo: { enabled: options.demo === true, email: null, password: null },
  } as SetupState);
  const rootRoute = createRootRouteWithContext<Record<string, never>>()({
    component: () => (
      <SidebarProvider>
        <StartEntry />
      </SidebarProvider>
    ),
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren(["/", "/other"].map(page)),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: {},
  });
  await router.load();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <StaticSessionProvider value={options.session ?? session()}>
            <RouterProvider router={router} />
          </StaticSessionProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await tick();
  });
  await settle();
  return router;
}

const entry = () => document.querySelector<HTMLElement>('[data-slot="start"]');
const button = () => entry()?.querySelector<HTMLButtonElement>("button") ?? null;
const popover = () => document.querySelector<HTMLElement>('[data-slot="start-popover"]');
const item = (id: string) => popover()?.querySelector<HTMLElement>(`[data-item="${id}"]`) ?? null;

async function openPopover() {
  await act(async () => {
    button()?.click();
    await tick();
  });
}

describe("the entry", () => {
  it("shows Start with the count and a ring, once the checklist is in", async () => {
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(OPEN) });
    await mountStart({ fetch: mock });
    expect(entry()?.getAttribute("data-done")).toBe("3");
    expect(entry()?.textContent).toContain("Start");
    expect(entry()?.textContent).toContain("3 of 7 done");
    expect(button()?.getAttribute("aria-label")).toBe("Start, 3 of 7 steps done");
    const ring = entry()?.querySelectorAll('[data-slot="start-ring"]');
    // One beside the text, one around the rocket for the collapsed sidebar.
    expect(ring?.length).toBe(2);
    expect(button()?.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("asks only for the setup (widgets=setup), and not again just because the popover opens", async () => {
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(OPEN) });
    const urls: string[] = [];
    await mountStart({
      fetch: (input, init) => {
        urls.push(String(input));
        return mock(input, init);
      },
    });
    await openPopover();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/dashboard\?widgets=setup$/);
  });

  it("is not there once every step is done", async () => {
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(setupOf()) });
    await mountStart({ fetch: mock });
    expect(entry()).toBeNull();
  });

  it("is never shown to an end user, and asks nothing for one", async () => {
    const { mock, requests } = routedFetch({ "GET /dashboard": () => setupResponse(OPEN) });
    await mountStart({
      fetch: mock,
      session: session({ role: "tenant_user", isProviderAdmin: false }),
    });
    expect(entry()).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("is hidden under All tenants, and asks nothing there", async () => {
    const { mock, requests } = routedFetch({ "GET /dashboard": () => setupResponse(OPEN) });
    await mountStart({ fetch: mock, session: session({ scope: "all" }) });
    expect(entry()).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("is not there when the checklist could not be read", async () => {
    const { mock } = routedFetch({
      "GET /dashboard": () =>
        new Response(JSON.stringify({ widgets: { setup: { state: "error" } } }), {
          headers: { "content-type": "application/json" },
        }),
    });
    await mountStart({ fetch: mock });
    expect(entry()).toBeNull();
  });
});

describe("the popover", () => {
  it("lists the seven steps with their state, and the way to each open one", async () => {
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(OPEN) });
    await mountStart({ fetch: mock });
    await openPopover();
    expect(popover()?.textContent).toContain("Set up Müller GmbH");
    expect(popover()?.textContent).toContain("3 of 7 steps done");
    expect(popover()?.querySelectorAll("li[data-item]")).toHaveLength(7);
    expect(item("storage")?.getAttribute("data-state")).toBe("done");
    expect(item("schedules")?.getAttribute("data-state")).toBe("open");
    expect(item("firstVerification")?.getAttribute("data-state")).toBe("attention");

    // An open step says why and has its existing action.
    expect(item("schedules")?.textContent).toContain("No backup schedule is active.");
    expect(item("schedules")?.querySelector("a")?.textContent).toBe("Open schedules");
    expect(item("firstBackup")?.querySelector("a")?.textContent).toBe("Start a backup");
    // A step that needs attention says so.
    expect(item("firstVerification")?.textContent).toContain("Needs attention.");
    // A done step has no button.
    expect(item("storage")?.querySelector("a")).toBeNull();
    expect(item("storage")?.textContent).not.toContain("Open storage");
    expect(popover()?.textContent).toContain(
      "Start disappears from the menu once every step is done.",
    );
  });

  it("ticks a done step in the primary colour, never green", async () => {
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(OPEN) });
    await mountStart({ fetch: mock });
    await openPopover();
    const mark = item("storage")?.querySelector('[data-slot="start-mark"]');
    expect(mark?.className).toContain("bg-primary");
    expect(mark?.className).not.toMatch(/success|green/);
    expect(button()?.innerHTML).not.toMatch(/success|green/);
  });

  it("shows a step the viewer cannot do as information, not as a button", async () => {
    const { mock } = routedFetch({
      "GET /dashboard": () =>
        setupResponse(
          setupOf({ notificationMail: { state: "open", reason: "not_tested", actionable: false } }),
        ),
    });
    await mountStart({
      fetch: mock,
      session: session({ role: "tenant_admin", isProviderAdmin: false }),
    });
    await openPopover();
    const mail = item("notificationMail");
    expect(mail?.querySelector("a")).toBeNull();
    expect(mail?.textContent).toContain("Done by your provider");
    expect(mail?.textContent).not.toContain("Not needed");
  });
});

describe("Not needed on the notification mail", () => {
  const MAIL_OPEN = setupOf({ notificationMail: { state: "open", reason: "not_tested" } });
  const MAIL_MARKED = setupOf({
    schedules: { state: "open", reason: "no_backup_schedule" },
    notificationMail: { state: "not_needed", reason: "mail_marked" },
  });
  const notNeeded = () =>
    [...(item("notificationMail")?.querySelectorAll("button") ?? [])].find((candidate) =>
      /Not needed|Needed after all/.test(candidate.textContent ?? ""),
    );

  it("marks the mail as not needed through the installation setting, then lets Start go when nothing else is open", async () => {
    let current = MAIL_OPEN;
    const { mock, requests } = routedFetch({
      "GET /dashboard": () => setupResponse(current),
      "PUT /settings/mail/not-needed": () => {
        current = setupOf({ notificationMail: { state: "not_needed", reason: "mail_marked" } });
        return new Response(JSON.stringify({ notNeeded: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    await mountStart({ fetch: mock });
    await openPopover();
    expect(notNeeded()?.disabled).toBe(false);
    await act(async () => {
      notNeeded()?.click();
      await tick();
    });
    await settle();
    expect(requests.find((request) => request.method === "PUT")).toMatchObject({
      path: "/settings/mail/not-needed",
      body: { notNeeded: true },
    });
    // Everything else was done: the entry is gone.
    expect(entry()).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Marked as not needed.");
  });

  it("shows a marked step as settled, with the way back", async () => {
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(MAIL_MARKED) });
    await mountStart({ fetch: mock });
    await openPopover();
    const mail = item("notificationMail");
    expect(mail?.getAttribute("data-state")).toBe("not_needed");
    expect(mail?.textContent).toContain("Marked as not needed.");
    expect(notNeeded()?.textContent).toBe("Needed after all");
    // Settled steps count: 6 done and one not needed would be 7, here one other is open.
    expect(entry()?.getAttribute("data-done")).toBe("6");
  });

  it("offers no way back for a mail the setup skipped, which is not needed by itself", async () => {
    const { mock } = routedFetch({
      "GET /dashboard": () =>
        setupResponse(
          setupOf({
            schedules: { state: "open", reason: "no_backup_schedule" },
            notificationMail: { state: "not_needed", reason: "mail_skipped" },
          }),
        ),
    });
    await mountStart({ fetch: mock });
    await openPopover();
    expect(item("notificationMail")?.textContent).toContain("You skipped the mail step");
    expect(notNeeded()).toBeUndefined();
  });

  it("is closed to a provider role below Owner, and in the public demo, with the reason", async () => {
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(MAIL_OPEN) });
    await mountStart({ fetch: mock, session: session({ providerRole: "administrator" }) });
    await openPopover();
    expect(notNeeded()?.disabled).toBe(true);
    expect(notNeeded()?.getAttribute("aria-description")).toContain("Owner role");
    expect(notNeeded()?.closest('[data-slot="disabled-reason"]')).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();

    const demo = routedFetch({ "GET /dashboard": () => setupResponse(MAIL_OPEN) });
    await mountStart({ fetch: demo.mock, demo: true });
    await openPopover();
    expect(notNeeded()?.disabled).toBe(true);
    expect(notNeeded()?.getAttribute("aria-description")).toBe("Closed in the public demo.");
  });

  it("is not offered on any other step", async () => {
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(OPEN) });
    await mountStart({ fetch: mock });
    await openPopover();
    for (const id of ["schedules", "firstBackup", "firstVerification"]) {
      expect(item(id)?.textContent, id).not.toContain("Not needed");
    }
  });
});

describe("when the last step is done", () => {
  it("says so once, and the entry is gone", async () => {
    let current: SetupWidget = setupOf({ firstBackup: { state: "open" } });
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(current) });
    const router = await mountStart({ fetch: mock });
    expect(entry()).not.toBeNull();
    expect(toast.success).not.toHaveBeenCalled();

    current = setupOf();
    // Doing a step happens on another page: the checklist is read again when the page changes.
    await act(async () => {
      await router.navigate({ to: "/other" as never });
    });
    await settle();
    expect(entry()).toBeNull();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Setup complete. Start is gone from the menu.");

    // Reading it again changes nothing: no second toast.
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await settle();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the app opens on a finished setup", async () => {
    const { mock } = routedFetch({ "GET /dashboard": () => setupResponse(setupOf()) });
    await mountStart({ fetch: mock });
    expect(entry()).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
