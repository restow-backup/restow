import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
  type CreateExportRequest,
  type MailExport,
  cancelExport,
  createExport,
  exportKeys,
  fetchExport,
  fetchExportFormats,
  fetchExports,
} from "@/features/exports/api";
import { isLive } from "@/features/exports/lib/exports";
import { useSession } from "@/lib/session";

/**
 * Data hooks for the export dialog and the export pages. Every key carries
 * the active tenant, and nothing runs before the session is settled.
 */

function useTenantScope() {
  const { status, activeTenant } = useSession();
  return { tenantId: activeTenant?.id ?? null, enabled: status === "authenticated" };
}

/** Poll quickly while anything is queued or running, slowly otherwise. */
export const LIVE_POLL_MS = 3_000;
export const IDLE_POLL_MS = 30_000;

/** The formats this installation offers; they change only with an update, so cache generously. */
export function useExportFormats() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: exportKeys.formats(tenantId),
    queryFn: fetchExportFormats,
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function useCreateExport() {
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  return useMutation({
    mutationFn: (request: CreateExportRequest) => createExport(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: exportKeys.list(tenantId) });
    },
  });
}

export function useExports() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: exportKeys.list(tenantId),
    queryFn: fetchExports,
    enabled,
    refetchInterval: (query) =>
      query.state.data?.some((item: MailExport) => isLive(item)) ? LIVE_POLL_MS : IDLE_POLL_MS,
  });
}

export function useExport(exportId: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: exportKeys.detail(tenantId, exportId),
    queryFn: () => fetchExport(exportId),
    enabled,
    refetchInterval: (query) =>
      query.state.data && isLive(query.state.data) ? LIVE_POLL_MS : false,
  });
}

export function useCancelExport() {
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  return useMutation({
    mutationFn: (exportId: string) => cancelExport(exportId),
    onSuccess: (detail) => {
      queryClient.setQueryData(exportKeys.detail(tenantId, detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: exportKeys.list(tenantId) });
    },
  });
}

/** The active tenant id, for URLs that cannot carry the tenant header (downloads). */
export function useActiveTenantId(): string | null {
  return useTenantScope().tenantId;
}

/**
 * The current time, refreshed every `intervalMs` while `enabled`: the expiry
 * countdown of a download link. Idle when there is nothing to count down.
 */
export function useClock(enabled: boolean, intervalMs = 20_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}
