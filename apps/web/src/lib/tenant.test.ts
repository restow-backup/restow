import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeTenantIdFor,
  canEnterTenant,
  forgetActiveTenant,
  getActiveTenantId,
  pickActiveTenant,
  readRememberedScope,
  readRememberedTenantId,
  rememberScope,
  roleInActiveTenant,
  setActiveTenantId,
} from "./tenant.js";

const tenants = [
  { id: "t1", name: "One", open: true },
  { id: "t2", name: "Two", open: true },
  { id: "t3", name: "Three", open: false },
];

describe("pickActiveTenant", () => {
  it("honours the first preference that exists", () => {
    expect(pickActiveTenant(tenants, [null, "missing", "t2", "t1"])?.id).toBe("t2");
  });

  it("falls back to the first tenant", () => {
    expect(pickActiveTenant(tenants, [undefined, "nope"])?.id).toBe("t1");
  });

  it("returns null without tenants", () => {
    expect(pickActiveTenant([], ["t1"])).toBeNull();
  });

  it("skips a preferred tenant the person cannot enter", () => {
    const open = (tenant: (typeof tenants)[number]) => tenant.open;
    expect(pickActiveTenant(tenants, ["t3", "t2"], open)?.id).toBe("t2");
    expect(pickActiveTenant(tenants, ["t3"], open)?.id).toBe("t1");
  });

  it("still names a tenant when every tenant is closed, so the shell can explain", () => {
    const closed = [{ id: "t9", open: false }];
    expect(pickActiveTenant(closed, [], (tenant) => tenant.open)?.id).toBe("t9");
  });
});

describe("canEnterTenant", () => {
  it("opens active tenants to everyone and closed ones to provider admins only", () => {
    expect(canEnterTenant("active", false)).toBe(true);
    expect(canEnterTenant("suspended", false)).toBe(false);
    expect(canEnterTenant("deleting", false)).toBe(false);
    expect(canEnterTenant("suspended", true)).toBe(true);
  });
});

describe("roleInActiveTenant", () => {
  it("uses the membership role of the active tenant", () => {
    expect(roleInActiveTenant(false, { role: "tenant_user" })).toBe("tenant_user");
    expect(roleInActiveTenant(false, { role: "tenant_admin" })).toBe("tenant_admin");
  });

  it("makes provider admins provider admins in every tenant", () => {
    expect(roleInActiveTenant(true, { role: "tenant_user" })).toBe("provider_admin");
    expect(roleInActiveTenant(true, null)).toBe("provider_admin");
  });

  it("has no tenant role without an active tenant", () => {
    expect(roleInActiveTenant(false, null)).toBeNull();
  });
});

describe("active tenant id", () => {
  afterEach(() => {
    forgetActiveTenant();
    vi.unstubAllGlobals();
  });

  it("keeps the value in memory even without storage", () => {
    setActiveTenantId("t9");
    expect(getActiveTenantId()).toBe("t9");
    setActiveTenantId(null);
    expect(getActiveTenantId()).toBeNull();
  });

  it("remembers the choice across a reload and forgets it only on sign-out", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });

    setActiveTenantId("t2");
    // After a reload the tenant list is not there yet: no tenant, but the
    // remembered choice must still be there when the list arrives.
    setActiveTenantId(null);
    expect(getActiveTenantId()).toBeNull();
    expect(readRememberedTenantId()).toBe("t2");

    forgetActiveTenant();
    expect(readRememberedTenantId()).toBeNull();
  });
});

describe("the remembered scope", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    forgetActiveTenant();
    vi.unstubAllGlobals();
  });

  it("is one tenant until All tenants is chosen, and is remembered per browser", () => {
    expect(readRememberedScope()).toBe("tenant");
    rememberScope("all");
    expect(readRememberedScope()).toBe("all");
    expect(localStorage.getItem("restow.scope")).toBe("all");
    rememberScope("tenant");
    expect(readRememberedScope()).toBe("tenant");
    expect(localStorage.getItem("restow.scope")).toBeNull();
  });

  it("is forgotten with the active tenant on sign-out", () => {
    rememberScope("all");
    setActiveTenantId("t2");
    forgetActiveTenant();
    expect(readRememberedScope()).toBe("tenant");
    expect(readRememberedTenantId()).toBeNull();
  });

  it("does not fail where storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberScope("all")).not.toThrow();
    expect(readRememberedScope()).toBe("tenant");
    expect(() => forgetActiveTenant()).not.toThrow();
  });
});

/** A localStorage that works in the node environment. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("activeTenantIdFor", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    forgetActiveTenant();
    vi.unstubAllGlobals();
  });

  const me = (over: Partial<Parameters<typeof activeTenantIdFor>[0] & object> = {}) => ({
    role: "tenant_admin" as const,
    tenants: [
      { id: "t1", status: "active" as const },
      { id: "t2", status: "active" as const },
    ],
    activeTenantId: "t1",
    ...over,
  });

  it("prefers the tenant chosen in this page load, then the remembered one, then the server's hint", () => {
    expect(activeTenantIdFor(me())).toBe("t1");
    localStorage.setItem("restow.activeTenant", "t2");
    expect(activeTenantIdFor(me())).toBe("t2");
    setActiveTenantId("t1");
    expect(activeTenantIdFor(me())).toBe("t1");
  });

  it("skips a tenant the person cannot enter or does not belong to", () => {
    localStorage.setItem("restow.activeTenant", "gone");
    expect(activeTenantIdFor(me())).toBe("t1");
    setActiveTenantId("t2");
    expect(
      activeTenantIdFor(
        me({
          tenants: [
            { id: "t1", status: "active" },
            { id: "t2", status: "suspended" },
          ],
        }),
      ),
    ).toBe("t1");
    // The provider enters a suspended tenant.
    expect(
      activeTenantIdFor(
        me({
          role: "provider_admin",
          tenants: [
            { id: "t1", status: "active" },
            { id: "t2", status: "suspended" },
          ],
        }),
      ),
    ).toBe("t2");
  });

  it("takes a profile from an older server, with no status, as active", () => {
    expect(activeTenantIdFor(me({ tenants: [{ id: "t1" }] }))).toBe("t1");
  });

  it("has no tenant for a person who belongs to none", () => {
    expect(activeTenantIdFor(me({ tenants: [], activeTenantId: null }))).toBeNull();
  });
});
