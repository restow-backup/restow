import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchTenants, queryKeys } from "@/lib/api";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import { editionAllows, readEdition } from "../license/edition";

import {
  type InviteMemberInput,
  type MemberScopeInput,
  fetchTeam,
  inviteMember,
  reissueInvitation,
  removeMember,
  teamKeys,
  updateMember,
} from "./api";

/**
 * Who may see and change the team: every provider admin whose role covers
 * every tenant may look (the API's rule, apps/api lib/provider-access.ts);
 * only owners change it. Business and Service Provider (`provider.team`).
 */
export function useTeamScope() {
  const session = useSession();
  const licensed = editionAllows(readEdition(session.extensions), "business");
  return {
    licensed,
    canView: licensed && providerMay(session, "read_only", { everyTenant: true }),
    canManage: licensed && providerMay(session, "owner", { everyTenant: true }),
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
