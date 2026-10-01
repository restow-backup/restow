import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { tenantKeys } from "@/features/tenants/api";

import {
  checkSetPasswordToken,
  fetchPendingAccounts,
  provisionAccount,
  redeemSetPasswordToken,
  reissueAccountLink,
} from "./api";
import type { ProvisionAccountInput } from "./types";

/** TanStack Query hooks of the accounts feature. */

export const accountKeys = {
  pending: (tenantId: string) => ["accounts", "pending", tenantId] as const,
};

/** Pending accounts (provisioned, password not set yet) of one tenant. */
export function usePendingAccounts(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: accountKeys.pending(tenantId),
    queryFn: () => fetchPendingAccounts(tenantId),
    enabled: enabled && tenantId.length > 0,
  });
}

export function useProvisionAccount(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProvisionAccountInput) => provisionAccount(tenantId, input),
    onSuccess: () => {
      // A brand new member (or a role granted for the first time) should show
      // up in the Members table right away, not only after its own staleTime.
      queryClient.invalidateQueries({ queryKey: accountKeys.pending(tenantId) });
      queryClient.invalidateQueries({ queryKey: tenantKeys.members(tenantId) });
    },
  });
}

export function useReissueAccountLink(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => reissueAccountLink(tenantId, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.pending(tenantId) }),
  });
}

// --- The public set-password page ----------------------------------------------------

export function useSetPasswordTokenStatus(token: string) {
  return useQuery({
    queryKey: ["accounts", "set-password-status", token],
    queryFn: () => checkSetPasswordToken(token),
    retry: false,
    staleTime: 0,
  });
}

export function useRedeemSetPasswordToken() {
  return useMutation({
    mutationFn: (input: { token: string; password: string }) => redeemSetPasswordToken(input),
  });
}
