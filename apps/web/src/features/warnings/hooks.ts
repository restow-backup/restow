import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { NavBadge } from "@/lib/navigation";

import { useSession } from "@/lib/session";

import {
  acknowledgeWarnings,
  fetchWarning,
  fetchWarnings,
  revokeAcknowledgement,
  type WarningRef,
  warningKeys,
} from "./api";
import { attentionCount, mayAcknowledge } from "./presenters";

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

/**
 * The menu entry's count: what the page of the active tenant asks to look at (open warnings,
 * failed backups, objects to confirm), from the same cached query the page reads (nothing under
 * "All tenants", where no tenant is active).
 */
export function useOpenWarningsBadge(): NavBadge | null {
  const { t } = useTranslation("warnings");
  const { data } = useWarnings("open");
  const count = data ? attentionCount(data.counts) : 0;
  return count > 0 ? { count, label: t("navBadge", { count }) } : null;
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
