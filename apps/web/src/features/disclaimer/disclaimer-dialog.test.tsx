// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { type SetupState, queryKeys } from "@/lib/api";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";

import { DisclaimerDialog, mayAcceptDisclaimer, shouldAskForDisclaimer } from "./disclaimer-dialog";

/**
 * The blocking dialog of an installation that was set up before the operator
 * notice existed (or whose text changed): shown to a provider admin only, not
 * dismissable, closed by accepting. What the server records is proven in
 * apps/api (routes/setup.pg.test.ts); here the wiring: who sees it, that the
 * box gates the button, that accepting posts the shown version to the settings
 * route and that signing out stays possible.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const VERSION = "2026-09-30";

const running: SetupState = {
  configured: true,
  productName: "Restow",
  operatingMode: "public",
  publicUrl: "https://backup.example.test",
  passkeyReady: { ready: true, reasons: [], rpId: "backup.example.test", origin: null },
  mailTransport: "smtp",
  disclaimer: { version: VERSION, accepted: false },
  setupToken: { required: false, source: null },
  microsoftSignIn: false,
  demo: { enabled: false, email: null, password: null },
};

const providerAdmin: SessionContextValue = {
  status: "authenticated",
  user: { id: "u1", email: "ops@provider.example", name: "Ops" },
  role: "provider_admin",
  features: [],
  extensions: {},
  isProviderAdmin: true,
  tenants: [],
  activeTenant: null,
  setActiveTenant: () => undefined,
  version: null,
  signOut: vi.fn(async () => undefined),
  refresh: async () => undefined,
  error: null,
};

const tenantAdmin: SessionContextValue = {
  ...providerAdmin,
  role: "tenant_admin",
  isProviderAdmin: false,
};

const asRole = (providerRole: "owner" | "administrator" | "technician" | "read_only") => ({
  ...providerAdmin,
  providerRole,
  providerAllTenants: true,
  signOut: vi.fn(async () => undefined),
});

const fetchMock = vi.fn();

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function mount(state: SetupState, session: SessionContextValue): Promise<void> {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.setupState, state);
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <StaticSessionProvider value={session}>
            <DisclaimerDialog />
          </StaticSessionProvider>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await flush();
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
    await flush();
  });
}

/** The dialog is portalled to the body, so queries go through the document. */
function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="alertdialog"]');
}

function button(label: string): HTMLButtonElement {
  const match = [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) {
    throw new Error(`expected a button labelled "${label}"`);
  }
  return match;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  navigateSpy.mockReset();
});

describe("shouldAskForDisclaimer", () => {
  it("asks a provider admin of a configured installation that has not accepted", () => {
    expect(shouldAskForDisclaimer(running, true)).toBe(true);
  });

  it("does not ask anyone else, nor an installation that accepted or is not set up", () => {
    expect(shouldAskForDisclaimer(running, false)).toBe(false);
    expect(
      shouldAskForDisclaimer(
        { ...running, disclaimer: { version: VERSION, accepted: true } },
        true,
      ),
    ).toBe(false);
    expect(shouldAskForDisclaimer({ ...running, configured: false }, true)).toBe(false);
    expect(shouldAskForDisclaimer(undefined, true)).toBe(false);
  });
});

describe("mayAcceptDisclaimer", () => {
  it("lets owners and administrators accept, and nobody below them", () => {
    expect(mayAcceptDisclaimer(asRole("owner"))).toBe(true);
    expect(mayAcceptDisclaimer(asRole("administrator"))).toBe(true);
    expect(mayAcceptDisclaimer(asRole("technician"))).toBe(false);
    expect(mayAcceptDisclaimer(asRole("read_only"))).toBe(false);
    // A provider admin without a reported team role is an owner, as the API treats them.
    expect(mayAcceptDisclaimer(providerAdmin)).toBe(true);
    expect(mayAcceptDisclaimer(tenantAdmin)).toBe(false);
  });
});

describe("DisclaimerDialog", () => {
  it("blocks a provider admin with the notice until it is accepted", async () => {
    await mount(running, providerAdmin);

    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain("Operator responsibility notice");
    expect(dialog()?.textContent).toContain("Restow is a tool for backup and archiving");
    expect(dialog()?.textContent).toContain("Archive and GoBD");
    expect(button("Accept and continue").disabled).toBe(true);
    // The only other way out is signing out.
    expect(button("Sign out").disabled).toBe(false);
  });

  it("stays closed for everyone the notice does not concern", async () => {
    await mount(running, tenantAdmin);
    expect(dialog()).toBeNull();
  });

  it("stays closed once accepted", async () => {
    await mount({ ...running, disclaimer: { version: VERSION, accepted: true } }, providerAdmin);
    expect(dialog()).toBeNull();
  });

  it("posts the shown version to the settings route once the box is ticked, then closes", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: VERSION, accepted: true, acceptedAt: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await mount(running, providerAdmin);

    const box = dialog()?.querySelector('[role="checkbox"]') as HTMLElement;
    await click(box);
    expect(button("Accept and continue").disabled).toBe(false);
    await click(button("Accept and continue"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/api\/v1\/settings\/disclaimer$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ version: VERSION, accepted: true });

    expect(dialog()).toBeNull();
    expect(queryClient.getQueryData<SetupState>(queryKeys.setupState)?.disclaimer.accepted).toBe(
      true,
    );
  });

  it("stays open with the cause when the acceptance could not be saved", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ type: "about:blank", title: "Boom", status: 500 }), {
        status: 500,
        headers: { "content-type": "application/problem+json" },
      }),
    );
    await mount(running, providerAdmin);

    await click(dialog()?.querySelector('[role="checkbox"]') as HTMLElement);
    await click(button("Accept and continue"));

    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain("Your acceptance could not be saved.");
  });

  it("does not close on Escape", async () => {
    await mount(running, providerAdmin);
    await act(async () => {
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await flush();
    });
    expect(dialog()).not.toBeNull();
  });

  it("signs the person out instead of accepting", async () => {
    await mount(running, providerAdmin);
    await click(button("Sign out"));
    expect(providerAdmin.signOut).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks an administrator to accept like an owner", async () => {
    await mount(running, asRole("administrator"));
    expect(dialog()?.querySelector('[role="checkbox"]')).not.toBeNull();
    expect(button("Accept and continue")).toBeTruthy();
  });

  for (const role of ["technician", "read_only"] as const) {
    it(`tells a ${role} member that an owner or administrator must accept first`, async () => {
      const session = asRole(role);
      await mount(running, session);

      expect(dialog()).not.toBeNull();
      expect(dialog()?.textContent).toContain("An owner or administrator of the provider team");
      // No notice to tick and nothing to accept: the only way on is signing out.
      expect(dialog()?.querySelector('[role="checkbox"]')).toBeNull();
      expect(dialog()?.textContent).not.toContain("Accept and continue");

      await click(button("Sign out"));
      expect(session.signOut).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});
