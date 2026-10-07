import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/lib/session";

import {
  type WarningRef,
  acknowledgeWarnings,
  fetchWarning,
  fetchWarnings,
  revokeAcknowledgement,
  warningKeys,
} from "./api";
import { mayAcknowledge } from "./presenters";

/** The active tenant, whether tenant-scoped queries may run, and whether the viewer may acknowledge. */
export function useWarningsScope() {
  const session = useSession();
  return {
    tenantId: session.activeTenant?.id ?? null,
    enabled: session.status === "authenticated" && session.activeTenant !== null,
    canAcknowledge: mayAcknowledge(session),
  };
}

export function useWarnings(state: "open" | "acknowledged") {
  const { tenantId, enabled } = useWarningsScope();
  return useQuery({
    queryKey: warningKeys.list(tenantId, state),
    queryFn: () => fetchWarnings(state),
    enabled,
  });
}

export function useWarning(ref: WarningRef | null) {
  const { tenantId, enabled } = useWarningsScope();
  return useQuery({
    queryKey: ref ? warningKeys.detail(tenantId, ref) : ["tenant", tenantId, "warnings", "none"],
    queryFn: () => fetchWarning(ref as WarningRef),
    enabled: enabled && ref !== null,
  });
}

/**
 * An acknowledgement changes what the start page, the directory, the jobs and the status count:
 * everything of the tenant is read again.
 */
function useRefreshTenant() {
  const queryClient = useQueryClient();
  const { tenantId } = useWarningsScope();
  return () => queryClient.invalidateQueries({ queryKey: ["tenant", tenantId] });
}

export function useAcknowledge() {
  const refresh = useRefreshTenant();
  return useMutation({
    mutationFn: ({ targets, note }: { targets: readonly WarningRef[]; note: string | null }) =>
      acknowledgeWarnings(targets, note),
    onSettled: refresh,
  });
}

export function useRevokeAcknowledgement() {
  const refresh = useRefreshTenant();
  return useMutation({
    mutationFn: (ref: WarningRef) => revokeAcknowledgement(ref),
    onSettled: refresh,
  });
}
