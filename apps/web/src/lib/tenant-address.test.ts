import { describe, expect, it } from "vitest";

import { addressedTenant } from "./tenant-address";

const tenants = [{ id: "a" }, { id: "b" }];

describe("a link that names its tenant", () => {
  it("switches into a tenant the viewer may work in", () => {
    expect(addressedTenant("b", tenants, "a", false)).toEqual({ kind: "switch", tenantId: "b" });
    // Under "All tenants" the named tenant becomes the active one, too.
    expect(addressedTenant("a", tenants, "a", true)).toEqual({ kind: "switch", tenantId: "a" });
    expect(addressedTenant("a", tenants, "a", false)).toEqual({ kind: "current" });
  });

  it("never switches into a tenant the viewer has no access to", () => {
    expect(addressedTenant("z", tenants, "a", false)).toEqual({ kind: "denied" });
    expect(addressedTenant(undefined, tenants, "a", false)).toEqual({ kind: "none" });
  });
});
