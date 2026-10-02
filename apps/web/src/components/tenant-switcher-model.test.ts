import { describe, expect, it } from "vitest";

import {
  foldForSearch,
  matchTenantSearch,
  orderTenants,
  tenantSearchValue,
  tenantSublineOf,
} from "./tenant-switcher-model";

const tenant = (overrides: Partial<Parameters<typeof tenantSearchValue>[0]> = {}) => ({
  name: "Müller GmbH",
  slug: "mueller",
  kind: "customer" as const,
  customerNumber: null as string | null,
  ...overrides,
});

describe("orderTenants", () => {
  it("lists the own organisation first and keeps the rest in order", () => {
    const list = [
      { id: "a", kind: "customer" as const },
      { id: "b", kind: "customer" as const },
      { id: "own", kind: "internal" as const },
      { id: "c", kind: "customer" as const },
    ];
    expect(orderTenants(list).map((entry) => entry.id)).toEqual(["own", "a", "b", "c"]);
  });

  it("changes nothing without an own organisation, and does not touch its input", () => {
    const list = [
      { id: "a", kind: "customer" as const },
      { id: "b", kind: "customer" as const },
    ];
    expect(orderTenants(list)).toEqual(list);
    expect(orderTenants(list)).not.toBe(list);
  });
});

describe("tenant search", () => {
  const value = tenantSearchValue(tenant({ customerNumber: "KD-10234" }));

  it("runs over name, customer number and slug", () => {
    expect(value).toBe("Müller GmbH KD-10234 mueller");
    expect(tenantSearchValue(tenant())).toBe("Müller GmbH mueller");
  });

  it("finds a tenant by a part of its name", () => {
    expect(matchTenantSearch(value, "müll")).toBe(1);
    expect(matchTenantSearch(value, "GMBH")).toBe(1);
    expect(matchTenantSearch(value, "nord")).toBe(0);
  });

  it("finds a tenant by its customer number, whole or in part", () => {
    expect(matchTenantSearch(value, "KD-10234")).toBe(1);
    expect(matchTenantSearch(value, "kd-102")).toBe(1);
    expect(matchTenantSearch(value, "10234")).toBe(1);
    expect(matchTenantSearch(value, "10235")).toBe(0);
  });

  it("ignores accents on both sides, and case", () => {
    expect(foldForSearch("Bäckerei Krüger")).toBe("backerei kruger");
    expect(matchTenantSearch(value, "muller")).toBe(1);
    expect(matchTenantSearch(tenantSearchValue(tenant({ name: "Muller AG" })), "müller")).toBe(1);
  });

  it("wants every word, in any order", () => {
    expect(matchTenantSearch(value, "gmbh kd-10")).toBe(1);
    expect(matchTenantSearch(value, "kd-10 gmbh")).toBe(1);
    expect(matchTenantSearch(value, "gmbh kd-99")).toBe(0);
  });

  it("matches everything for an empty search", () => {
    expect(matchTenantSearch(value, "")).toBe(1);
    expect(matchTenantSearch(value, "   ")).toBe(1);
  });
});

describe("tenantSublineOf", () => {
  it("says Internal for the own organisation, the number for a customer, Tenant without one", () => {
    expect(tenantSublineOf(tenant({ kind: "internal" }), false)).toEqual({ kind: "internal" });
    // The own organisation reads Internal even when it has a customer number.
    expect(tenantSublineOf(tenant({ kind: "internal", customerNumber: "KD-1" }), false)).toEqual({
      kind: "internal",
    });
    expect(tenantSublineOf(tenant({ customerNumber: "KD-10234" }), false)).toEqual({
      kind: "number",
      number: "KD-10234",
    });
    expect(tenantSublineOf(tenant(), false)).toEqual({ kind: "tenant" });
  });

  it("says Organisation, never Internal or Tenant, where the installation has one organisation", () => {
    expect(tenantSublineOf(tenant({ kind: "internal" }), true)).toEqual({ kind: "organisation" });
    expect(tenantSublineOf(tenant(), true)).toEqual({ kind: "organisation" });
    expect(tenantSublineOf(tenant({ customerNumber: "KD-10234" }), true)).toEqual({
      kind: "number",
      number: "KD-10234",
    });
  });
});
