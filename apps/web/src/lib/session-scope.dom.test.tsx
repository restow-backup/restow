// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, routedFetch } from "@/features/updates/testing";

import type { Me } from "./api";
import {
  type SessionContextValue,
  SessionProvider,
  canViewAllTenants,
  sessionScope,
  useSession,
} from "./session";
import { readRememberedScope } from "./tenant";

/**
 * "All tenants" in the session: who is offered it, that it is remembered per
 * browser like the active tenant, and that choosing a tenant leaves it. The
 * browser's own sign-in client is replaced; the profile and the tenant list come
 * from a stand-in for the API.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { session: { id: "s1" }, user: { id: "u1" } },
      isPending: false,
      error: null,
      refetch: async () => {},
    }),
    getSession: async () => ({ data: null, error: null }),
    signOut: async () => {},
  },
}));

const OWN = { id: "own", name: "Own", slug: "own", kind: "internal", status: "active" };
const A = { id: "a", name: "Alpha", slug: "alpha", kind: "customer", status: "active" };
const B = { id: "b", name: "Beta", slug: "beta", kind: "customer", status: "active" };

function profile(over: Partial<Me> = {}): Me {
  return {
    user: { id: "u1", name: "Alex", email: "alex@example.test" },
    role: "provider_admin",
    tenants: [OWN, A, B].map((tenant) => ({ ...tenant, role: "tenant_admin" })) as Me["tenants"],
    activeTenantId: "a",
    features: ["tenants.additional", "dashboard.allTenants"],
    extensions: {},
    provider: { role: "owner", allTenants: true },
    ...over,
  };
}

class MemoryStorage {
  private items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let seen: SessionContextValue | null = null;

function Probe() {
  seen = useSession();
  return null;
}

async function mountSession(me: Me) {
  const { mock } = routedFetch({
    "GET /me": () => json(me),
    "GET /tenants": () => json([OWN, A, B]),
    "GET /setup/state": () =>
      json({ configured: true, demo: { enabled: false, email: null, password: null } }),
  });
  vi.stubGlobal("fetch", mock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SessionProvider>
          <Probe />
        </SessionProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  seen = null;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("who is offered All tenants", () => {
  const sp = {
    isProviderAdmin: true,
    providerAllTenants: true,
    features: ["tenants.additional", "dashboard.allTenants"] as const,
    tenantCount: 3,
  };

  it("is a provider admin who covers every tenant, on a Service Provider installation with more than one tenant", () => {
    expect(canViewAllTenants({ ...sp, features: [...sp.features] })).toBe(true);
  });

  it("is nobody else", () => {
    const features = [...sp.features];
    expect(canViewAllTenants({ ...sp, features, isProviderAdmin: false })).toBe(false);
    // A team member limited to some tenants would see tenants that are not theirs.
    expect(canViewAllTenants({ ...sp, features, providerAllTenants: false })).toBe(false);
    // Community and Business have one organisation.
    expect(canViewAllTenants({ ...sp, features: [] })).toBe(false);
    expect(canViewAllTenants({ ...sp, features: ["dashboard.allTenants"] })).toBe(false);
    expect(canViewAllTenants({ ...sp, features: ["tenants.additional"] })).toBe(false);
    expect(canViewAllTenants({ ...sp, features: null })).toBe(false);
    // Nothing to look across.
    expect(canViewAllTenants({ ...sp, features, tenantCount: 1 })).toBe(false);
    expect(canViewAllTenants({ ...sp, features, tenantCount: 0 })).toBe(false);
  });
});

describe("the scope of the session", () => {
  it("starts on one tenant and offers All tenants to a provider admin of a Service Provider", async () => {
    await mountSession(profile());
    expect(seen && sessionScope(seen)).toBe("tenant");
    expect(seen?.canViewAllTenants).toBe(true);
    expect(seen?.activeTenant?.id).toBe("a");
  });

  it("offers nothing to a tenant admin, and to a team member limited to some tenants", async () => {
    await mountSession(profile({ role: "tenant_admin" }));
    expect(seen?.canViewAllTenants).toBe(false);
    act(() => root?.unmount());
    host?.remove();
    await mountSession(profile({ provider: { role: "technician", allTenants: false } }));
    expect(seen?.canViewAllTenants).toBe(false);
    // Asking anyway changes nothing.
    act(() => seen?.setScopeAll?.());
    expect(seen && sessionScope(seen)).toBe("tenant");
  });

  it("offers nothing on Community and Business", async () => {
    await mountSession(profile({ features: [] }));
    expect(seen?.canViewAllTenants).toBe(false);
  });

  it("works across all tenants once asked, keeps the tenant underneath and remembers it per browser", async () => {
    await mountSession(profile());
    await act(async () => seen?.setScopeAll?.());
    expect(seen && sessionScope(seen)).toBe("all");
    expect(seen?.activeTenant?.id).toBe("a");
    expect(readRememberedScope()).toBe("all");
  });

  it("picks the remembered scope up again after a reload", async () => {
    localStorage.setItem("restow.scope", "all");
    await mountSession(profile());
    expect(seen && sessionScope(seen)).toBe("all");
  });

  it("drops the remembered scope when it is no longer on offer, without forgetting it", async () => {
    localStorage.setItem("restow.scope", "all");
    await mountSession(profile({ features: [] }));
    expect(seen && sessionScope(seen)).toBe("tenant");
  });

  it("leaves All tenants by choosing a tenant, even the one that was active underneath", async () => {
    await mountSession(profile());
    await act(async () => seen?.setScopeAll?.());
    expect(seen && sessionScope(seen)).toBe("all");
    await act(async () => seen?.setActiveTenant("a"));
    expect(seen && sessionScope(seen)).toBe("tenant");
    expect(seen?.activeTenant?.id).toBe("a");
    expect(readRememberedScope()).toBe("tenant");

    await act(async () => seen?.setScopeAll?.());
    await act(async () => seen?.setActiveTenant("b"));
    expect(seen && sessionScope(seen)).toBe("tenant");
    expect(seen?.activeTenant?.id).toBe("b");
  });
});
