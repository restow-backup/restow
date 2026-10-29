import { describe, expect, it } from "vitest";
import { inactiveState, isManyInactive } from "./inactive.js";

describe("inactiveState", () => {
  it("is to_confirm for an unconfirmed orphan, confirmed once someone confirmed it", () => {
    expect(inactiveState({ status: "orphaned", statusConfirmedAt: null })).toBe("to_confirm");
    expect(inactiveState({ status: "orphaned" })).toBe("to_confirm");
    expect(inactiveState({ status: "orphaned", statusConfirmedAt: new Date() })).toBe("confirmed");
    expect(inactiveState({ status: "orphaned", statusConfirmedAt: "2026-10-29T10:00:00Z" })).toBe(
      "confirmed",
    );
  });

  it("is null for active and excluded objects, whatever is stored", () => {
    expect(inactiveState({ status: "active", statusConfirmedAt: new Date() })).toBeNull();
    expect(inactiveState({ status: "excluded" })).toBeNull();
  });
});

describe("isManyInactive", () => {
  it("is true above 10 objects at once", () => {
    expect(isManyInactive(10, 10_000)).toBe(false);
    expect(isManyInactive(11, 10_000)).toBe(true);
  });

  it("is true above 20% of the tenant's objects that were active, from two objects on", () => {
    // 3 of 20 = 15%: notices.
    expect(isManyInactive(3, 17)).toBe(false);
    // 5 of 20 = 25%: one warning.
    expect(isManyInactive(5, 15)).toBe(true);
    // One object of a three-person tenant stays a notice.
    expect(isManyInactive(1, 2)).toBe(false);
    expect(isManyInactive(2, 2)).toBe(true);
    expect(isManyInactive(0, 0)).toBe(false);
  });
});
