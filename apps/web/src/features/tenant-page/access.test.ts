import { describe, expect, it } from "vitest";

import type { SessionTenant } from "@/lib/session";

import { resolveTenantPageAccess, tenantWriteBlock } from "./access";

function tenant(over: Partial<SessionTenant> = {}): SessionTenant {
  return {
    id: "t1",
    name: "Contoso",
    slug: "contoso",
    kind: "customer",
    customerNumber: null,
    role: "tenant_admin",
    status: "active",
    ...over,
  };
}

describe("resolveTenantPageAccess", () => {
  it("opens the page for the administrator of the tenant, and for a provider admin of any tenant", () => {
    const tenants = [tenant(), tenant({ id: "t2", role: "tenant_user" })];
    expect(resolveTenantPageAccess({ isProviderAdmin: false, tenants, tenantId: "t1" })).toEqual({
      kind: "ok",
      tenant: tenants[0],
    });
    // A provider admin administers every tenant, whatever the role the list carries.
    expect(resolveTenantPageAccess({ isProviderAdmin: true, tenants, tenantId: "t2" }).kind).toBe(
      "ok",
    );
  });

  it("says plainly that another tenant is not theirs, instead of failing", () => {
    expect(
      resolveTenantPageAccess({ isProviderAdmin: false, tenants: [tenant()], tenantId: "other" }),
    ).toEqual({ kind: "notYours" });
  });

  it("tells a provider admin when the tenant does not exist or lies outside their scope", () => {
    expect(
      resolveTenantPageAccess({ isProviderAdmin: true, tenants: [tenant()], tenantId: "other" }),
    ).toEqual({ kind: "unknown" });
  });

  it("gives an end user no tenant page, also for their own tenant", () => {
    const user = tenant({ role: "tenant_user" });
    expect(
      resolveTenantPageAccess({ isProviderAdmin: false, tenants: [user], tenantId: "t1" }),
    ).toEqual({ kind: "notAdmin", tenant: user });
  });

  it("closes a suspended tenant to its own administrators, not to the provider", () => {
    const suspended = tenant({ status: "suspended" });
    expect(
      resolveTenantPageAccess({ isProviderAdmin: false, tenants: [suspended], tenantId: "t1" }),
    ).toEqual({ kind: "closed", tenant: suspended });
    expect(
      resolveTenantPageAccess({ isProviderAdmin: true, tenants: [suspended], tenantId: "t1" }).kind,
    ).toBe("ok");
  });
});

describe("tenantWriteBlock", () => {
  it("lets a tenant's own administrator and an owner or administrator of the provider team change settings", () => {
    expect(
      tenantWriteBlock({ demo: false, isProviderAdmin: false, providerRole: null }),
    ).toBeNull();
    for (const providerRole of ["owner", "administrator", null, undefined] as const) {
      expect(tenantWriteBlock({ demo: false, isProviderAdmin: true, providerRole })).toBeNull();
    }
  });

  it("closes the settings for a technician and a read-only member, with the role as the reason", () => {
    for (const providerRole of ["technician", "read_only"] as const) {
      expect(tenantWriteBlock({ demo: false, isProviderAdmin: true, providerRole })).toBe("role");
    }
  });

  it("closes them in the public demo before anything is clicked, whoever looks", () => {
    expect(tenantWriteBlock({ demo: true, isProviderAdmin: true, providerRole: "owner" })).toBe(
      "demo",
    );
    expect(tenantWriteBlock({ demo: true, isProviderAdmin: false, providerRole: null })).toBe(
      "demo",
    );
  });
});
