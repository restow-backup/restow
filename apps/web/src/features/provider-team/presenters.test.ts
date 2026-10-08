import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import {
  STATUS_VARIANT,
  normalizeDraft,
  scopeIsValid,
  teamErrorKey,
  tenantScopeChoice,
} from "./presenters";

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

  it("offers the tenant scope only where the installation enables it", () => {
    expect(tenantScopeChoice({ tenantScope: true, member: null })).toBe("open");
    expect(tenantScopeChoice({ tenantScope: true, member: { allTenants: false } })).toBe("open");
    // Community and Business: every member has every tenant.
    expect(tenantScopeChoice({ tenantScope: false, member: null })).toBe("locked");
    expect(tenantScopeChoice({ tenantScope: false, member: { allTenants: true } })).toBe("locked");
    // A limit from before stays as it is (or is widened), never changed.
    expect(tenantScopeChoice({ tenantScope: false, member: { allTenants: false } })).toBe("kept");
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
    for (const [type, key] of [
      ["urn:restow:problem:provider-team-reset-self", "team:errors.resetSelf"],
      ["urn:restow:problem:provider-team-not-active", "team:errors.notActive"],
    ] as const) {
      expect(teamErrorKey(new ApiError(409, { type, title: "x", status: 409 }, "Conflict"))).toBe(
        key,
      );
    }
    expect(teamErrorKey(new Error("x"))).toBe("common:errors.generic");
  });
});
