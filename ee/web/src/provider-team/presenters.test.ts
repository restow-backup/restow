import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import { STATUS_VARIANT, normalizeDraft, scopeIsValid, teamErrorKey } from "./presenters";

describe("team presenters", () => {
  it("keeps green out of the member status: an active member is a state, not a proof", () => {
    expect(STATUS_VARIANT).toEqual({
      active: "outline",
      invited: "info",
      invitation_expired: "warning",
    });
  });

  it("gives an owner every tenant", () => {
    expect(normalizeDraft({ role: "owner", allTenants: false, tenantIds: ["a"] })).toEqual({
      role: "owner",
      allTenants: true,
      tenantIds: [],
    });
  });

  it("needs a tenant for a member limited to some", () => {
    expect(scopeIsValid({ role: "technician", allTenants: false, tenantIds: [] })).toBe(false);
    expect(scopeIsValid({ role: "technician", allTenants: false, tenantIds: ["a"] })).toBe(true);
    expect(scopeIsValid({ role: "owner", allTenants: false, tenantIds: [] })).toBe(true);
  });

  it("maps the team's own refusals", () => {
    const error = new ApiError(
      409,
      {
        type: "urn:restow:problem:provider-team-last-owner",
        title: "x",
        status: 409,
      },
      "Conflict",
    );
    expect(teamErrorKey(error)).toBe("team:errors.lastOwner");
    expect(teamErrorKey(new Error("x"))).toBe("common:errors.generic");
  });
});
