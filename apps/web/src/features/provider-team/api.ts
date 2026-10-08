import { type ProviderRole, apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/provider-team (apps/api features/provider-team),
 * in every edition. A member limited to chosen tenants needs the gated
 * feature `providerTeam.tenantScope`; without it the API refuses a limit
 * with 403 (`feature-unavailable`, or `edition-required` from ee/).
 */

export type MemberStatus = "active" | "invited" | "invitation_expired";

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: ProviderRole;
  allTenants: boolean;
  tenantIds: string[];
  status: MemberStatus;
  isYou: boolean;
  addedAt: string;
}

export interface MemberScopeInput {
  role: ProviderRole;
  allTenants: boolean;
  tenantIds: string[];
}

export interface InviteMemberInput extends MemberScopeInput {
  email: string;
  name: string;
}

/** An invitation, a reissued invitation link or a reset of a member's access. */
export interface Invitation {
  member: TeamMember;
  /** Only when the link could not be mailed; the owner hands it over. */
  setPasswordToken: string | null;
  linkExpiresAt: string;
  mailOutcome: "sent" | "not_configured" | "failed";
}

const TEAM = "/provider-team";
const memberPath = (userId: string) => `${TEAM}/${encodeURIComponent(userId)}`;

export function fetchTeam(): Promise<{ items: TeamMember[] }> {
  return apiFetch<{ items: TeamMember[] }>(TEAM, { tenantId: null });
}

export function inviteMember(input: InviteMemberInput): Promise<Invitation> {
  return apiFetch<Invitation>(TEAM, { method: "POST", body: input, tenantId: null });
}

export function updateMember(userId: string, input: MemberScopeInput): Promise<TeamMember> {
  return apiFetch<TeamMember>(memberPath(userId), { method: "PATCH", body: input, tenantId: null });
}

export function removeMember(userId: string): Promise<void> {
  return apiFetch<void>(memberPath(userId), { method: "DELETE", tenantId: null });
}

export function reissueInvitation(userId: string): Promise<Invitation> {
  return apiFetch<Invitation>(`${memberPath(userId)}/reissue`, { method: "POST", tenantId: null });
}

/**
 * Take an active member's password, passkeys, authenticator app and sessions
 * away and issue a fresh set-password link (owners; needs a recent sign-in).
 */
export function resetAccess(userId: string): Promise<Invitation> {
  return apiFetch<Invitation>(`${memberPath(userId)}/reset-access`, {
    method: "POST",
    tenantId: null,
  });
}

export const teamKeys = {
  list: ["provider-team"] as const,
};
