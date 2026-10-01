import { describe, expect, it } from "vitest";

import { providerMay, providerRoleSatisfies } from "./provider-role";

describe("providerMay", () => {
  it("is false for anyone who is not a provider admin", () => {
    expect(providerMay({ isProviderAdmin: false, providerRole: null }, "read_only")).toBe(false);
  });

  it("follows the role ranking", () => {
    const tech = {
      isProviderAdmin: true,
      providerRole: "technician" as const,
      providerAllTenants: true,
    };
    expect(providerMay(tech, "technician")).toBe(true);
    expect(providerMay(tech, "read_only")).toBe(true);
    expect(providerMay(tech, "administrator")).toBe(false);
    expect(providerRoleSatisfies("owner", "administrator")).toBe(true);
  });

  it("treats a provider admin without a reported role as an owner (older servers)", () => {
    expect(providerMay({ isProviderAdmin: true }, "owner")).toBe(true);
  });

  it("needs every tenant for installation-wide actions", () => {
    const scoped = {
      isProviderAdmin: true,
      providerRole: "administrator" as const,
      providerAllTenants: false,
    };
    expect(providerMay(scoped, "administrator")).toBe(true);
    expect(providerMay(scoped, "administrator", { everyTenant: true })).toBe(false);
  });
});
