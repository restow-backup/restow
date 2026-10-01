import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { i18n } from "@/i18n";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";

import {
  type MaintenanceView,
  type ReleaseView,
  type RunView,
  type UpdatesView,
  idleMaintenance,
} from "./api";
import "./i18n";

/**
 * Fixtures and DOM helpers of the updates tests (not part of the app bundle:
 * nothing imports this file outside `*.test.*`).
 */

/** Tells React that `act` is in charge (see components/kit/page-context.test.tsx). */
export function enableActEnvironment(): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

export const NOW = Date.parse("2026-09-30T12:00:00.000Z");

export function iso(offsetSeconds = 0, base = NOW): string {
  return new Date(base + offsetSeconds * 1000).toISOString();
}

export function releaseFixture(overrides: Partial<ReleaseView> = {}): ReleaseView {
  return {
    version: "0.2.0",
    tag: "v0.2.0",
    name: "Restow 0.2.0",
    publishedAt: "2026-09-28T09:00:00.000Z",
    url: "https://github.com/restow-backup/restow/releases/tag/v0.2.0",
    prerelease: false,
    notes: "## What's changed\n\n- The maintenance banner\n- Faster **restores**\n",
    notesTruncated: false,
    digests: { app: `sha256:${"a".repeat(64)}`, web: `sha256:${"b".repeat(64)}` },
    ...overrides,
  };
}

export function runFixture(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "r-1",
    mode: "image",
    fromVersion: "0.1.0",
    targetVersion: "0.2.0",
    targetTag: "v0.2.0",
    releaseUrl: "https://github.com/restow-backup/restow/releases/tag/v0.2.0",
    requestedBy: { userId: "u1", label: "owner@example.test" },
    scheduledAt: iso(-600),
    leadSeconds: 300,
    startsAt: iso(-300),
    startedAt: iso(-300),
    finishedAt: iso(-60),
    cancelledAt: null,
    outcome: "succeeded",
    step: "finish",
    steps: [
      { id: "prepare", status: "done", startedAt: null, finishedAt: null, detail: {} },
      { id: "fetch", status: "done", startedAt: null, finishedAt: null, detail: {} },
      { id: "backup", status: "done", startedAt: null, finishedAt: null, detail: {} },
      { id: "stop", status: "done", startedAt: null, finishedAt: null, detail: {} },
      { id: "start", status: "done", startedAt: null, finishedAt: null, detail: {} },
      { id: "health", status: "done", startedAt: null, finishedAt: null, detail: {} },
      { id: "finish", status: "done", startedAt: null, finishedAt: null, detail: {} },
    ],
    progress: 100,
    message: null,
    failure: null,
    recovery: null,
    images: {
      app: "ghcr.io/restow-backup/restow:0.2.0",
      web: "ghcr.io/restow-backup/restow-web:0.2.0",
    },
    digestVerified: true,
    signatureVerified: true,
    log: [],
    cancelled: false,
    ...overrides,
  };
}

export function updatesFixture(overrides: Partial<UpdatesView> = {}): UpdatesView {
  return {
    running: "0.1.0",
    demo: false,
    settings: { enabled: true, channel: "stable", sourceUrl: null, tokenSet: false },
    environmentOverride: null,
    source: {
      origin: "default",
      url: "https://github.com/restow-backup/restow",
      provider: "github",
      repository: "restow-backup/restow",
      isDefault: true,
    },
    mode: "image",
    sourceAllowed: true,
    check: {
      enabled: true,
      state: "ok",
      checkedAt: iso(-3600),
      nextCheckAt: iso(3600 * 20),
      error: null,
    },
    latest: releaseFixture(),
    updateAvailable: true,
    releases: [releaseFixture()],
    updater: {
      state: "ready",
      blockers: [],
      incompatible: false,
      version: "0.1.0",
      runner: "cli",
      dumps: [],
      checkedAt: iso(-60),
    },
    leadTimes: [0, 60, 300, 900, 1800, 3600],
    maintenance: idleMaintenance(new Date(NOW)),
    run: null,
    ...overrides,
  };
}

export function maintenanceFixture(overrides: Partial<MaintenanceView> = {}): MaintenanceView {
  return { ...idleMaintenance(new Date(NOW)), runningVersion: "0.1.0", ...overrides };
}

export const SESSION: SessionContextValue = {
  status: "authenticated",
  user: { id: "u1", email: "owner@example.test", name: "Owner" },
  role: "provider_admin",
  features: [],
  extensions: {},
  isProviderAdmin: true,
  providerRole: "owner",
  providerAllTenants: true,
  tenants: [],
  activeTenant: null,
  setActiveTenant: () => undefined,
  version: null,
  signOut: async () => undefined,
  refresh: async () => undefined,
  error: null,
};

export function sessionAs(overrides: Partial<SessionContextValue>): SessionContextValue {
  return { ...SESSION, ...overrides };
}

export function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
}

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  queryClient: QueryClient;
  render: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
}

/** Mount `node` inside i18n, a query client and a session, into the document. */
export function mount(
  node: ReactNode,
  options: { session?: SessionContextValue; queryClient?: QueryClient } = {},
): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = options.queryClient ?? newQueryClient();
  const session = options.session ?? SESSION;

  const wrap = (children: ReactNode) => (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <StaticSessionProvider value={session}>{children}</StaticSessionProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );

  const render = async (children: ReactNode) => {
    await act(async () => {
      root.render(wrap(children));
      await Promise.resolve();
    });
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const mounted: Mounted = { container, root, queryClient, render, unmount };
  act(() => root.render(wrap(node)));
  return mounted;
}

/** Let pending promises and timers of zero delay settle inside `act`. */
export async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export async function click(element: Element | null | undefined): Promise<void> {
  if (!element) {
    throw new Error("click: element not found");
  }
  await act(async () => {
    (element as HTMLElement).click();
    await Promise.resolve();
  });
}

/** Type into a controlled input the way a browser does (React tracks the value setter). */
export async function type(input: Element | null | undefined, value: string): Promise<void> {
  if (!input) {
    throw new Error("type: input not found");
  }
  const element = input as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

/** Leave a field the way a browser does (React's `onBlur` listens to `focusout`). */
export async function blur(element: Element | null | undefined): Promise<void> {
  if (!element) {
    throw new Error("blur: element not found");
  }
  await act(async () => {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await Promise.resolve();
  });
}

export function buttonByText(scope: ParentNode, text: string | RegExp): HTMLButtonElement | null {
  const buttons = [...scope.querySelectorAll<HTMLButtonElement>("button")];
  return (
    buttons.find((button) => {
      const label = button.textContent?.trim() ?? "";
      const named = button.getAttribute("aria-label") ?? "";
      return typeof text === "string"
        ? label === text || named === text
        : text.test(label) || text.test(named);
    }) ?? null
  );
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

export function problem(
  type: string,
  status: number,
  extra: Record<string, unknown> = {},
): Response {
  return json({ type, title: type, status, ...extra }, status);
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

/**
 * A fetch stand-in that routes by `METHOD /path` (path without the `/api/v1`
 * prefix) and records every request. An unrouted request fails the test.
 */
export function routedFetch(routes: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];
  const mock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const request = { method, path, body };
    requests.push(request);
    const handler = routes[`${method} ${path}`];
    if (!handler) {
      throw new Error(`Unrouted request: ${method} ${url.pathname}`);
    }
    return handler(request);
  };
  return { mock, requests };
}

/** A working `Storage` (Node's own experimental `localStorage` shadows the DOM's in newer versions). */
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }
  [name: string]: unknown;
}

/** Give the page fresh, working `localStorage` and `sessionStorage`. */
export function installMemoryStorage(): void {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(window, name, {
      configurable: true,
      writable: true,
      value: new MemoryStorage(),
    });
  }
}
