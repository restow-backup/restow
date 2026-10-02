import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { i18n } from "@/i18n";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";

import "../i18n";

// React only flushes effects synchronously inside `act` when it knows a test
// renderer is driving it (see components/kit/page-context.test.tsx).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const TENANT_ID = "11111111-1111-4111-8111-111111111111";

export function sessionValue(
  role: "tenant_admin" | "tenant_user" = "tenant_admin",
): SessionContextValue {
  const tenant = {
    id: TENANT_ID,
    name: "Acme GmbH",
    slug: "acme",
    kind: "customer" as const,
    customerNumber: null,
    role,
    status: "active" as const,
  };
  return {
    status: "authenticated",
    user: { id: "u1", name: "Lena Schneider", email: "lena@acme.example" },
    role,
    features: [],
    extensions: {},
    isProviderAdmin: false,
    tenants: [tenant],
    activeTenant: tenant,
    setActiveTenant: () => {},
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
  };
}

export interface Mounted {
  container: HTMLElement;
  queryClient: QueryClient;
  unmount: () => void;
}

/** Mount `node` with i18n, a fresh query client and a tenant admin session. */
export function mount(node: ReactNode, session: SessionContextValue = sessionValue()): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <StaticSessionProvider value={session}>{node}</StaticSessionProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    );
  });
  return {
    container,
    queryClient,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * Poll `check` until it stops throwing. Each wait happens in its own `act`, so
 * the updates the page makes meanwhile are rendered before the next look (state
 * changes inside one long `act` only render when it ends).
 */
export async function until(check: () => void, timeout = 4_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - started > timeout) {
        throw error;
      }
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
}

export function text(container: HTMLElement): string {
  return container.textContent ?? "";
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

export function button(container: HTMLElement, name: RegExp | string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) =>
    typeof name === "string"
      ? candidate.textContent?.includes(name)
      : name.test(`${candidate.textContent ?? ""} ${candidate.getAttribute("aria-label") ?? ""}`),
  );
  if (!match) {
    throw new Error(`no button matching ${String(name)}`);
  }
  return match as HTMLButtonElement;
}

export async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Type into a React-controlled input. */
export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
