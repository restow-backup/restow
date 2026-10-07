import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
  type CreateExportRequest,
  type MailExport,
  cancelExport,
  createExport,
  exportKeys,
  fetchExport,
  fetchExportFormats,
  fetchExportList,
} from "@/features/exports/api";
import { isLive } from "@/features/exports/lib/exports";
import { fetchPages } from "@/lib/paged-list";
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

/** Exports per page of the list (the API's maximum). */
export const EXPORTS_PAGE = 50;

/** The newest `pages` pages of exports, whether older ones exist, and the download period. */
export function useExports(pages = 1) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: [...exportKeys.list(tenantId), pages],
    queryFn: async () => {
      let ttlHours: number | null = null;
      const list = await fetchPages(
        async (offset) => {
          const page = await fetchExportList(offset);
          ttlHours ??= page.ttlHours;
          return page.items;
        },
        EXPORTS_PAGE,
        pages,
      );
      return { ...list, ttlHours };
    },
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.items.some((item: MailExport) => isLive(item))
        ? LIVE_POLL_MS
        : IDLE_POLL_MS,
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
