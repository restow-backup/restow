import { describe, expect, it } from "vitest";
import { customerTenants } from "./service.js";

describe("customerTenants", () => {
  it("leaves the operator's own organisation out of the customers", () => {
    const usage = [
      { id: "a", kind: "customer" as const },
      { id: "own", kind: "internal" as const },
      { id: "b", kind: "customer" as const },
    ];
    expect(customerTenants(usage).map((tenant) => tenant.id)).toEqual(["a", "b"]);
  });

  it("keeps every tenant when none is the own organisation", () => {
    expect(customerTenants([{ kind: "customer" as const }])).toHaveLength(1);
    expect(customerTenants([])).toEqual([]);
  });
});
