// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionContextValue, SessionTenant } from "@/lib/session";

import type { StorageRange } from "./ranges";
import { useDashboard } from "./use-dashboard";

/**
 * What the start page asks a provider admin about the own organisation
 * (`ownOrganisation`), read from the session: to set it up while there is none
 * (nothing selected at all, or tenants without one), or to add the first
 * customer once a service provider has only the own organisation. The rules
 * themselves are tested in features/tenants/presenters.test.ts; this proves the
 * hook feeds them from the session and stays silent for everyone else.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = vi.hoisted(() => ({ value: null as unknown }));
const fetched = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => session.value };
});
vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    fetchDashboard: (...args: unknown[]) => {
      fetched.calls.push(args);
      return new Promise(() => undefined);
    },
  };
});

function tenant(id: string, kind: "customer" | "internal"): SessionTenant {
  return {
    id,
    name: id,
    slug: id,
    kind,
    customerNumber: null,
    role: "tenant_admin",
    status: "active",
  };
}

function sessionOf(overrides: Partial<SessionContextValue>): SessionContextValue {
  const tenants = overrides.tenants ?? [];
  return {
    status: "authenticated",
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role: "provider_admin",
    features: [],
    extensions: {},
    isProviderAdmin: true,
    providerRole: "administrator",
    providerAllTenants: true,
    tenants,
    activeTenant: tenants[0] ?? null,
    setActiveTenant: () => {},
    version: null,
    signOut: async () => {},
    refresh: async () => {},
    error: null,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function readHook(value: SessionContextValue) {
  session.value = value;
  const seen: { noTenant: boolean; ownOrganisation: unknown }[] = [];
  function Probe() {
    const dashboard = useDashboard("tenant");
    seen.push({ noTenant: dashboard.noTenant, ownOrganisation: dashboard.ownOrganisation });
    return null;
  }
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Probe />
      </QueryClientProvider>,
    );
  });
  return seen.at(-1) as (typeof seen)[number];
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container = null;
});

describe("useDashboard, the own organisation", () => {
  it("asks a provider admin to set it up before any tenant exists", async () => {
    const seen = await readHook(sessionOf({ tenants: [], activeTenant: null }));
    expect(seen.noTenant).toBe(true);
    expect(seen.ownOrganisation).toMatchObject({ kind: "setUp", canManage: true, canCreate: true });
  });

  it("asks to set it up, and to choose among the tenants, when none of them is the own organisation", async () => {
    const seen = await readHook(
      sessionOf({
        tenants: [tenant("a", "customer")],
        features: ["tenants.additional"],
      }),
    );
    expect(seen.noTenant).toBe(false);
    expect(seen.ownOrganisation).toMatchObject({
      kind: "setUp",
      canCreate: true,
      existing: [{ id: "a" }],
    });
  });

  it("does not offer creating another tenant where only one may exist", async () => {
    const seen = await readHook(sessionOf({ tenants: [tenant("a", "customer")] }));
    expect(seen.ownOrganisation).toMatchObject({ kind: "setUp", canCreate: false });
  });

  it("asks a service provider with only the own organisation to add the first customer", async () => {
    const seen = await readHook(
      sessionOf({ tenants: [tenant("own", "internal")], features: ["tenants.additional"] }),
    );
    expect(seen.ownOrganisation).toEqual({ kind: "addCustomer" });
  });

  it("asks nothing once the own organisation and a customer exist", async () => {
    const seen = await readHook(
      sessionOf({
        tenants: [tenant("own", "internal"), tenant("a", "customer")],
        features: ["tenants.additional"],
      }),
    );
    expect(seen.ownOrganisation).toBeNull();
  });

  it("leaves what a role may not do to a note: a technician is told, not offered buttons", async () => {
    const seen = await readHook(sessionOf({ providerRole: "technician", tenants: [] }));
    expect(seen.ownOrganisation).toMatchObject({ kind: "setUp", canManage: false });
  });

  it("asks nobody who is not a provider admin", async () => {
    const seen = await readHook(
      sessionOf({
        role: "tenant_admin",
        isProviderAdmin: false,
        providerRole: null,
        tenants: [tenant("a", "customer")],
      }),
    );
    expect(seen.ownOrganisation).toBeNull();
  });

  it("asks nothing while the profile is still loading", async () => {
    const seen = await readHook(sessionOf({ status: "loading", tenants: [] }));
    expect(seen.ownOrganisation).toBeNull();
  });
});

describe("useDashboard, the storage growth window", () => {
  /** Renders the hook, optionally chooses a window, and returns what it shows and asked for. */
  async function withRange(user: string, choose?: StorageRange) {
    fetched.calls = [];
    session.value = sessionOf({
      user: { id: user, name: user, email: `${user}@example.test` },
      tenants: [tenant("a", "customer")],
    });
    let current: ReturnType<typeof useDashboard> | null = null;
    function Probe() {
      current = useDashboard("tenant");
      return null;
    }
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Probe />
        </QueryClientProvider>,
      );
    });
    if (choose) {
      await act(async () => {
        (current as ReturnType<typeof useDashboard> | null)?.setStorageRange(choose);
      });
    }
    const range = (current as ReturnType<typeof useDashboard> | null)?.storageRange;
    await act(async () => root?.unmount());
    root = null;
    return { range, calls: fetched.calls };
  }

  it("asks for the month by default, with no parameters", async () => {
    localStorage.clear();
    const { range, calls } = await withRange("anna");
    expect(range).toBe("30d");
    expect(calls).toEqual([["tenant", {}]]);
  });

  it("asks for the chosen window and remembers it for the same person only", async () => {
    localStorage.clear();
    const chosen = await withRange("anna", "365d");
    expect(chosen.range).toBe("365d");
    expect(chosen.calls.at(-1)).toEqual(["tenant", { storageDays: "365" }]);
    // Next visit: Anna's choice is back at once; Ben has his own.
    expect((await withRange("anna")).calls).toEqual([["tenant", { storageDays: "365" }]]);
    expect((await withRange("ben")).range).toBe("30d");
  });
});
