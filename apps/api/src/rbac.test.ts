import { describe, expect, it } from "vitest";
import {
  decideTenantAccess,
  globalRole,
  isProviderAdminRole,
  isTenantAdmin,
  membershipRoleFromTenantRole,
  roleSatisfies,
  splitRoles,
  tenantRoleFromMembership,
} from "./middleware/rbac.js";

describe("splitRoles", () => {
  it("handles empty, single and comma-separated values", () => {
    expect(splitRoles(null)).toEqual([]);
    expect(splitRoles(undefined)).toEqual([]);
    expect(splitRoles("")).toEqual([]);
    expect(splitRoles("owner")).toEqual(["owner"]);
    expect(splitRoles(" Admin , member ")).toEqual(["admin", "member"]);
  });
});

describe("isProviderAdminRole", () => {
  it("recognizes the better-auth admin role, also inside a list", () => {
    expect(isProviderAdminRole("admin")).toBe(true);
    expect(isProviderAdminRole("user,admin")).toBe(true);
    expect(isProviderAdminRole("user")).toBe(false);
    expect(isProviderAdminRole(null)).toBe(false);
    expect(isProviderAdminRole("administrator")).toBe(false);
  });
});

describe("tenantRoleFromMembership", () => {
  it("maps owner and admin to tenant_admin, everything else to tenant_user", () => {
    expect(tenantRoleFromMembership("owner")).toBe("tenant_admin");
    expect(tenantRoleFromMembership("admin")).toBe("tenant_admin");
    expect(tenantRoleFromMembership("member,admin")).toBe("tenant_admin");
    expect(tenantRoleFromMembership("member")).toBe("tenant_user");
    expect(tenantRoleFromMembership("")).toBe("tenant_user");
    expect(tenantRoleFromMembership(null)).toBe("tenant_user");
  });

  it("round-trips through the better-auth role", () => {
    expect(tenantRoleFromMembership(membershipRoleFromTenantRole("tenant_admin"))).toBe(
      "tenant_admin",
    );
    expect(tenantRoleFromMembership(membershipRoleFromTenantRole("tenant_user"))).toBe(
      "tenant_user",
    );
  });
});

describe("roleSatisfies", () => {
  it("orders provider_admin > tenant_admin > tenant_user", () => {
    expect(roleSatisfies("provider_admin", "tenant_admin")).toBe(true);
    expect(roleSatisfies("tenant_admin", "tenant_admin")).toBe(true);
    expect(roleSatisfies("tenant_user", "tenant_admin")).toBe(false);
    expect(roleSatisfies("tenant_user", "tenant_user")).toBe(true);
    expect(isTenantAdmin("provider_admin")).toBe(true);
    expect(isTenantAdmin("tenant_user")).toBe(false);
  });
});

describe("globalRole", () => {
  it("prefers the provider role, then the strongest membership", () => {
    expect(globalRole("admin", [])).toBe("provider_admin");
    expect(globalRole("user", ["member", "owner"])).toBe("tenant_admin");
    expect(globalRole(null, ["member"])).toBe("tenant_user");
    expect(globalRole(null, [])).toBe("tenant_user");
  });
});

describe("decideTenantAccess", () => {
  it("lets provider admins into any tenant regardless of membership", () => {
    expect(
      decideTenantAccess({
        isProviderAdmin: true,
        membershipRole: null,
        minimumRole: "tenant_admin",
      }),
    ).toEqual({ allowed: true, role: "provider_admin" });
  });

  it("rejects non-members", () => {
    expect(
      decideTenantAccess({
        isProviderAdmin: false,
        membershipRole: null,
        minimumRole: "tenant_user",
      }),
    ).toEqual({ allowed: false, reason: "not_a_member", role: null });
  });

  it("enforces the minimum role for members", () => {
    expect(
      decideTenantAccess({
        isProviderAdmin: false,
        membershipRole: "member",
        minimumRole: "tenant_admin",
      }),
    ).toEqual({ allowed: false, reason: "insufficient_role", role: "tenant_user" });
    expect(
      decideTenantAccess({
        isProviderAdmin: false,
        membershipRole: "member",
        minimumRole: "tenant_user",
      }),
    ).toEqual({ allowed: true, role: "tenant_user" });
    expect(
      decideTenantAccess({
        isProviderAdmin: false,
        membershipRole: "owner",
        minimumRole: "tenant_admin",
      }),
    ).toEqual({ allowed: true, role: "tenant_admin" });
  });
});
