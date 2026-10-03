import { ApiError, type ProviderRole, errorMessageKey } from "@/lib/api";

import type { MemberStatus } from "./api";

/**
 * Badge variant per member status; the status is always spelled out as well.
 * An active member is neutral (the outline): being active is a state, and green
 * is kept for proof, a passed restore check (brand guide, section 4).
 */
export const STATUS_VARIANT: Record<MemberStatus, "outline" | "info" | "warning"> = {
  active: "outline",
  invited: "info",
  invitation_expired: "warning",
};

export interface ScopeDraft {
  role: ProviderRole;
  allTenants: boolean;
  tenantIds: string[];
}

/** An owner always has every tenant; everyone else needs at least one when limited. */
export function normalizeDraft(draft: ScopeDraft): ScopeDraft {
  return draft.role === "owner" ? { ...draft, allTenants: true, tenantIds: [] } : draft;
}

export function scopeIsValid(draft: ScopeDraft): boolean {
  const normalized = normalizeDraft(draft);
  return normalized.allTenants || normalized.tenantIds.length > 0;
}

/**
 * How the tenant scope may be chosen in the member dialog:
 *
 *   open    limiting a member to chosen tenants is offered here (the gated
 *           feature `providerTeam.tenantScope`)
 *   kept    it is not, but the member already is limited (from before): the
 *           limit can stay exactly as it is, or be widened to every tenant
 *   locked  it is not: every member has every tenant, the choice is shown locked
 */
export type TenantScopeChoice = "open" | "kept" | "locked";

export function tenantScopeChoice(input: {
  tenantScope: boolean;
  member: { allTenants: boolean } | null;
}): TenantScopeChoice {
  if (input.tenantScope) {
    return "open";
  }
  return input.member && !input.member.allTenants ? "kept" : "locked";
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The i18n key for a failed team request: the team's own refusals first, then the shared ones. */
export function teamErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.problem?.type) {
      case "urn:restow:problem:provider-team-last-owner":
        return "team:errors.lastOwner";
      case "urn:restow:problem:provider-team-account-exists":
        return "team:errors.accountExists";
      case "urn:restow:problem:provider-team-no-tenants":
        return "team:errors.noTenants";
      case "urn:restow:problem:provider-team-reset-self":
        return "team:errors.resetSelf";
      case "urn:restow:problem:provider-team-not-active":
        return "team:errors.notActive";
    }
  }
  return `common:${errorMessageKey(error)}`;
}
