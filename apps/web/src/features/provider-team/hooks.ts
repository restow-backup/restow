import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchTenants, queryKeys } from "@/lib/api";
import { providerMay } from "@/lib/provider-role";
import { hasFeature, useSession } from "@/lib/session";

import {
  type InviteMemberInput,
  type MemberScopeInput,
  fetchTeam,
  inviteMember,
  reissueInvitation,
  removeMember,
  resetAccess,
  teamKeys,
  updateMember,
} from "./api";

/**
 * Who may see and change the team: every provider admin whose role covers
 * every tenant may look (the API's rule, apps/api lib/provider-access.ts);
 * only owners change it. `tenantScope`: whether a member may be limited to
 * chosen tenants here (the gated feature `providerTeam.tenantScope`).
 */
export function useTeamScope() {
  const session = useSession();
  return {
    canView: providerMay(session, "read_only", { everyTenant: true }),
    canManage: providerMay(session, "owner", { everyTenant: true }),
    tenantScope: hasFeature(session, "providerTeam.tenantScope"),
    isProviderAdmin: session.isProviderAdmin,
  };
}

export function useTeam() {
  const { canView } = useTeamScope();
  return useQuery({ queryKey: teamKeys.list, queryFn: fetchTeam, enabled: canView });
}

/** Every tenant, for the tenant picker (the provider's own list). */
export function useTenantChoices() {
  const { canManage } = useTeamScope();
  return useQuery({ queryKey: queryKeys.tenants, queryFn: fetchTenants, enabled: canManage });
}

function useInvalidateTeam() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: teamKeys.list });
}

export function useInviteMember() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (input: InviteMemberInput) => inviteMember(input),
    onSettled: invalidate,
  });
}

export function useUpdateMember() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: MemberScopeInput }) =>
      updateMember(userId, input),
    onSettled: invalidate,
  });
}

export function useRemoveMember() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (userId: string) => removeMember(userId),
    onSettled: invalidate,
  });
}

export function useReissueInvitation() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (userId: string) => reissueInvitation(userId),
    onSettled: invalidate,
  });
}

export function useResetAccess() {
  const invalidate = useInvalidateTeam();
  return useMutation({
    mutationFn: (userId: string) => resetAccess(userId),
    onSettled: invalidate,
  });
}
