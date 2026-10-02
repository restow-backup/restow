import { describe, expect, it } from "vitest";

import { READINESS_STATES, isReadinessState, parseVerifySearch, verifyLink } from "./search";

describe("the address of Recovery readiness", () => {
  it("knows the five states of the API", () => {
    expect([...READINESS_STATES]).toEqual(["green", "yellow", "red", "unverified", "no_backup"]);
    for (const state of READINESS_STATES) {
      expect(isReadinessState(state)).toBe(true);
    }
    for (const other of ["noBackup", "RED", "", null, undefined, 3, "all"]) {
      expect(isReadinessState(other)).toBe(false);
    }
  });

  it("keeps a known state and the all-tenants scope, and drops anything else", () => {
    expect(parseVerifySearch({ state: "red" })).toEqual({ state: "red" });
    expect(parseVerifySearch({ state: "no_backup", scope: "all" })).toEqual({
      state: "no_backup",
      scope: "all",
    });
    expect(parseVerifySearch({ state: "purple", scope: "everything", other: 1 })).toEqual({});
    expect(parseVerifySearch({ scope: "all" })).toEqual({ scope: "all" });
    expect(parseVerifySearch({})).toEqual({});
  });

  it("builds the links the overview, the legend and the provider table use", () => {
    expect(verifyLink("red")).toEqual({ to: "/verify", search: { state: "red" } });
    expect(verifyLink("unverified", "all")).toEqual({
      to: "/verify",
      search: { state: "unverified", scope: "all" },
    });
    expect(verifyLink()).toEqual({ to: "/verify", search: {} });
    expect(verifyLink(undefined, "all")).toEqual({ to: "/verify", search: { scope: "all" } });
  });
});
