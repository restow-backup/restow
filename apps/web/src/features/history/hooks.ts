import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import * as React from "react";

import { cancelJob, retryJob } from "@/features/jobs/api";
import { useSession } from "@/lib/session";

import {
  type HistoryFilters,
  type HistoryPage,
  type Run,
  type RunDetail,
  fetchHistory,
  fetchRunDetail,
  historyKeys,
} from "./api";
import { useLiveOpen, useLivePolling } from "./live/provider";
import { parseHistorySearch, withRun } from "./presenters";

/**
 * Data hooks of History and the run drawer. Every key carries the active tenant, nothing runs
 * before the session is settled. The live channel keeps what is loaded current; the intervals
 * below are the fallback while it is not connected, and `false` while it is.
 */

/** Without the live channel: how often a list asks again, quicker while something runs. */
export const IDLE_REFRESH_MS = 30_000;
export const RUNNING_REFRESH_MS = 6_000;
/** A running run's detail has parts only the server can derive (objects, timeline): ask now and then. */
export const DETAIL_REFRESH_LIVE_MS = 10_000;
export const DETAIL_REFRESH_FALLBACK_MS = 4_000;

export function useHistoryScope() {
  const { status, activeTenant } = useSession();
  return {
    tenantId: activeTenant?.id ?? null,
    enabled: status === "authenticated" && activeTenant !== null,
  };
}

/** Whether any loaded run is going. */
export function anyLive(pages: readonly HistoryPage[] | undefined): boolean {
  return (pages ?? []).some((page) =>
    page.items.some((run) => run.state === "running" || run.state === "queued"),
  );
}

/** The runs of the tenant, newest first, page by page; the channel moves the rows that are loaded. */
export function useHistory(filters: HistoryFilters) {
  const { tenantId, enabled } = useHistoryScope();
  const connected = useLiveOpen();
  const list = useInfiniteQuery({
    queryKey: historyKeys.list(tenantId, filters),
    queryFn: ({ pageParam }) => fetchHistory(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: HistoryPage) => last.next,
    enabled,
    // A tab switch keeps the old rows on screen until the new ones are there.
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      connected
        ? false
        : anyLive((query.state.data as InfiniteData<HistoryPage> | undefined)?.pages)
          ? RUNNING_REFRESH_MS
          : IDLE_REFRESH_MS,
  });
  const runs = React.useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );
  return { list, runs };
}

/** One run with its objects and timeline; a running run is read again now and then. */
export function useRunDetail(runId: string | null) {
  const { tenantId, enabled } = useHistoryScope();
  const live = useLivePolling(DETAIL_REFRESH_FALLBACK_MS);
  return useQuery<RunDetail>({
    queryKey: historyKeys.detail(tenantId, runId ?? ""),
    queryFn: () => fetchRunDetail(runId ?? ""),
    enabled: enabled && runId !== null,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === "running"
        ? live === false
          ? DETAIL_REFRESH_LIVE_MS
          : live
        : false,
  });
}

/**
 * The drawer of a run, as the address says it: `?run=<id>` on the page that hosts it, so a link
 * opens it. Opening adds the entry to the history (Back closes the drawer), closing replaces it.
 * Everything else in the address stays.
 */
export function useRunDrawer() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const { run } = parseHistorySearch(raw);

  const go = React.useCallback(
    (runId: string | null, replace: boolean) =>
      void navigate({
        to: pathname as never,
        search: withRun(raw, runId) as never,
        replace,
      }),
    [navigate, pathname, raw],
  );
  const open = React.useCallback((runId: string) => go(runId, false), [go]);
  const close = React.useCallback(() => go(null, true), [go]);
  // Moving from one run of a wave to another replaces the entry: Back leaves the drawer, not each run.
  const replaceWith = React.useCallback((runId: string) => go(runId, true), [go]);
  return { runId: run, open, close, replaceWith };
}

export function useCancelRun() {
  const queryClient = useQueryClient();
  const { tenantId } = useHistoryScope();
  return useMutation({
    mutationFn: (runId: string) => cancelJob(runId),
    onSettled: (_data, _error, runId) => {
      void queryClient.invalidateQueries({ queryKey: historyKeys.detail(tenantId, runId) });
    },
  });
}

export function useRetryRun() {
  const queryClient = useQueryClient();
  const { tenantId } = useHistoryScope();
  return useMutation({
    mutationFn: (runId: string) => retryJob(runId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: historyKeys.all(tenantId) });
    },
  });
}

/** The newer of the live run and the loaded detail's own copy of it (the stream may be a step ahead). */
export function mergeRun(detail: RunDetail | undefined, live: Run | undefined): Run | undefined {
  if (!detail) {
    return live;
  }
  if (!live) {
    return detail;
  }
  return live.updatedAt >= detail.updatedAt ? { ...detail, ...live } : detail;
}
