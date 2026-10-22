import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useJournalScope } from "../journal/hooks";
import {
  createForwardAddress,
  type ForwardingAccount,
  type ForwardingOverview,
  fetchForwarding,
  forwardingKeys,
  rotateForwardAddress,
} from "./api";

/** Copies arrive all the time: look again now and then. */
const REFRESH_MS = 30_000;

/** One page of the accounts whose job forwards copies to the archive. */
export function useForwarding(cursor: string | null) {
  const { tenantId, enabled, canManage, licensed } = useJournalScope();
  return useQuery({
    queryKey: forwardingKeys.page(tenantId, cursor),
    queryFn: () => fetchForwarding(cursor ?? undefined),
    enabled: enabled && canManage && licensed,
    placeholderData: (previous) => previous,
    refetchInterval: REFRESH_MS,
  });
}

/** The account in every cached page, replaced by what the server answered. */
function useReplaceAccount() {
  const { tenantId } = useJournalScope();
  const queryClient = useQueryClient();
  return (account: ForwardingAccount) => {
    queryClient.setQueriesData<ForwardingOverview>(
      { queryKey: forwardingKeys.all(tenantId) },
      (page) =>
        page
          ? {
              ...page,
              accounts: page.accounts.map((item) =>
                item.objectId === account.objectId ? account : item,
              ),
            }
          : page,
    );
  };
}

export function useCreateForwardAddress() {
  const replace = useReplaceAccount();
  return useMutation({ mutationFn: createForwardAddress, onSuccess: replace });
}

export function useRotateForwardAddress() {
  const replace = useReplaceAccount();
  return useMutation({ mutationFn: rotateForwardAddress, onSuccess: replace });
}
