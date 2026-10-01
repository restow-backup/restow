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
    }
  }
  return `common:${errorMessageKey(error)}`;
}
