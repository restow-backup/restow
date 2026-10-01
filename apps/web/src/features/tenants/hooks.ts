import {
  type QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { queryKeys } from "@/lib/api";
import { useSession } from "@/lib/session";

import {
  type MailTestResult,
  addMember,
  cancelInvitation,
  createTenant,
  deleteTenant,
  fetchMembers,
  fetchTenantDetail,
  fetchTenantHealth,
  fetchTenantList,
  fetchUsageOverview,
  removeMember,
  replaceTenantContacts,
  replaceTenantNotificationRecipients,
  sendNotificationTestMail,
  tenantKeys,
  updateMemberRole,
  updateTenant,
  updateTenantCustomer,
} from "./api";
import { canEnter } from "./presenters";
import type {
  AddMemberInput,
  CreateTenantInput,
  NotificationRecipientInput,
  TenantContactInput,
  TenantHealth,
  TenantItem,
  UpdateTenantCustomerInput,
  UpdateTenantInput,
} from "./types";

/**
 * TanStack Query hooks of the tenants feature. Tenant management is a
 * provider view; the member hooks also serve a tenant admin managing their
 * own tenant. Mutations refresh exactly what they change, plus the session's
 * tenant list (switcher) and `/me` when names or the set of tenants change.
 */

/** Provider-level queries run only for a signed-in provider admin. */
function useProviderScope() {
  const { status, isProviderAdmin } = useSession();
  return status === "authenticated" && isProviderAdmin;
}

export function useTenantList() {
  const enabled = useProviderScope();
  return useQuery({
    queryKey: tenantKeys.list,
    queryFn: fetchTenantList,
    enabled,
    refetchInterval: 60_000,
  });
}

/**
 * Protected mailboxes of the installation and per tenant. A failure is not
 * retried: the page says that usage is unavailable.
 */
export function useUsageOverview() {
  const enabled = useProviderScope();
  return useQuery({
    queryKey: tenantKeys.usage,
    queryFn: fetchUsageOverview,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export interface HealthState {
  status: "pending" | "error" | "success";
  data: TenantHealth | undefined;
}

/**
 * Readiness per tenant for the list, one request per tenant in that tenant's
 * context. Tenants being deleted are skipped: nothing is protected there any
 * more.
 */
export function useTenantHealths(tenants: readonly TenantItem[]): Map<string, HealthState> {
  const enabled = useProviderScope();
  const enterable = tenants.filter(canEnter);
  return useQueries({
    queries: enterable.map((tenant) => ({
      queryKey: tenantKeys.health(tenant.id),
      queryFn: () => fetchTenantHealth(tenant.id),
      enabled,
      staleTime: 60_000,
      refetchInterval: 120_000,
    })),
    combine: (results) =>
      new Map(
        results.map((result, index) => [
          enterable[index]?.id ?? "",
          { status: result.status, data: result.data } satisfies HealthState,
        ]),
      ),
  });
}

export function useTenantHealth(tenant: TenantItem | undefined) {
  const enabled = useProviderScope();
  return useQuery({
    queryKey: tenantKeys.health(tenant?.id ?? ""),
    queryFn: () => fetchTenantHealth(tenant?.id ?? ""),
    enabled: enabled && tenant !== undefined && canEnter(tenant),
    staleTime: 60_000,
  });
}

export function useTenantDetail(tenantId: string) {
  const enabled = useProviderScope();
  return useQuery({
    queryKey: tenantKeys.detail(tenantId),
    queryFn: () => fetchTenantDetail(tenantId),
    enabled: enabled && tenantId.length > 0,
    refetchInterval: 60_000,
  });
}

/** Members and pending invitations; tenant admins may read their own tenant's. */
export function useMembers(tenantId: string | null, enabled = true) {
  const { status } = useSession();
  return useQuery({
    queryKey: tenantKeys.members(tenantId ?? ""),
    queryFn: () => fetchMembers(tenantId ?? ""),
    enabled: enabled && status === "authenticated" && tenantId !== null,
  });
}

// --- Mutations ----------------------------------------------------------------------

/** Refresh the provider's tenant list, the switcher and `/me`. */
function refreshTenantSet(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: tenantKeys.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  ]);
}

export function useCreateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantInput) => createTenant(input),
    onSuccess: () => refreshTenantSet(queryClient),
  });
}

export function useUpdateTenant(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateTenantInput) => updateTenant(tenantId, patch),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: tenantKeys.detail(tenantId) }),
        queryClient.invalidateQueries({ queryKey: tenantKeys.list }),
        // The session's own tenant list (switcher) sits on the bare key.
        queryClient.invalidateQueries({ queryKey: tenantKeys.all, exact: true }),
        queryClient.invalidateQueries({ queryKey: tenantKeys.usage }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me }),
      ]),
  });
}

export function useUpdateTenantCustomer(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateTenantCustomerInput) => updateTenantCustomer(tenantId, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tenantKeys.detail(tenantId) }),
  });
}

export function useReplaceTenantContacts(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contacts: TenantContactInput[]) => replaceTenantContacts(tenantId, contacts),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tenantKeys.detail(tenantId) }),
  });
}

export function useReplaceTenantNotificationRecipients(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recipients: NotificationRecipientInput[]) =>
      replaceTenantNotificationRecipients(tenantId, recipients),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tenantKeys.detail(tenantId) }),
  });
}

/** Installation-wide, so no tenant to invalidate; used from Settings and the tenant wizard alike. */
export function useSendNotificationTestMail() {
  return useMutation<MailTestResult, unknown, string>({
    mutationFn: (to: string) => sendNotificationTestMail(to),
  });
}

export function useDeleteTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) => deleteTenant(tenantId),
    onSuccess: () => refreshTenantSet(queryClient),
  });
}

function useMemberMutation<TInput, TResult>(
  tenantId: string,
  mutationFn: (input: TInput) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: tenantKeys.members(tenantId) }),
        queryClient.invalidateQueries({ queryKey: tenantKeys.detail(tenantId) }),
      ]),
  });
}

export function useAddMember(tenantId: string) {
  return useMemberMutation(tenantId, (input: AddMemberInput) => addMember(tenantId, input));
}

export function useUpdateMemberRole(tenantId: string) {
  return useMemberMutation(tenantId, (input: { userId: string; role: AddMemberInput["role"] }) =>
    updateMemberRole(tenantId, input.userId, input.role),
  );
}

export function useRemoveMember(tenantId: string) {
  return useMemberMutation(tenantId, (userId: string) => removeMember(tenantId, userId));
}

export function useCancelInvitation(tenantId: string) {
  return useMemberMutation(tenantId, (invitationId: string) =>
    cancelInvitation(tenantId, invitationId),
  );
}
