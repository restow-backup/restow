import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as React from "react";

import {
  type BackupTarget,
  type Job,
  type JobDetail,
  type JobFilters,
  type JobPage,
  cancelJob,
  fetchBackupTargets,
  fetchJob,
  fetchJobs,
  fetchSnapshotHistory,
  jobEventsPath,
  jobKeys,
  jobsEventsPath,
  retryJob,
  startBackup,
} from "@/features/jobs/api";
import {
  isLive,
  jobsOfEvent,
  matchesFilters,
  replaceJobInPages,
  withLatestJob,
} from "@/features/jobs/presenters";
import { type ServerEvent, type StreamStatus, openEventStream } from "@/features/jobs/sse";
import { useSession } from "@/lib/session";

/**
 * Data hooks for the jobs pages. Lists come from REST (paged, filterable);
 * the SSE streams then keep whatever is loaded current: a changed job is
 * written into every cache entry that holds it, and a job the page does not
 * know yet makes the list refetch so it appears in its proper place.
 */

function useTenantId(): string | null {
  const { activeTenant, status } = useSession();
  return status === "authenticated" ? (activeTenant?.id ?? null) : null;
}

/** Keep a loaded job detail current with the job's latest summary. */
function patchDetail(queryClient: QueryClient, tenantId: string | null, job: Job): void {
  queryClient.setQueryData<JobDetail>(jobKeys.detail(tenantId, job.id), (detail) =>
    detail ? { ...detail, ...job } : detail,
  );
}

/** Refetch `key` once, shortly after the last request for it (bursts of events coalesce). */
function useDebouncedInvalidate(delayMs = 400) {
  const queryClient = useQueryClient();
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);
  return React.useCallback(
    (queryKey: readonly unknown[]) => {
      const id = JSON.stringify(queryKey);
      const existing = timers.current.get(id);
      if (existing) {
        clearTimeout(existing);
      }
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          void queryClient.invalidateQueries({ queryKey });
        }, delayMs),
      );
    },
    [queryClient, delayMs],
  );
}

/**
 * Follow an event stream while `path` is set; returns its state for the UI.
 * The handler may change between renders without reopening the stream.
 */
export function useEventStream(
  path: string | null,
  onEvent: (event: ServerEvent) => void,
): StreamStatus | null {
  const tenantId = useTenantId();
  const handler = React.useRef(onEvent);
  handler.current = onEvent;
  const [status, setStatus] = React.useState<StreamStatus | null>(null);

  React.useEffect(() => {
    if (!path || !tenantId) {
      setStatus(null);
      return;
    }
    const stream = openEventStream({
      path,
      tenantId,
      onEvent: (event) => handler.current(event),
      onStatus: setStatus,
    });
    return () => stream.close();
  }, [path, tenantId]);

  return status;
}

/** A clock that ticks while `enabled`, for countdowns and running durations. */
export function useNow(enabled: boolean, intervalMs = 1000): number {
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

// --- Lists --------------------------------------------------------------------

/** The paged job list for `filters`, kept live over the tenant-wide stream. */
export function useLiveJobs(filters: JobFilters) {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const invalidate = useDebouncedInvalidate();
  const listKey = jobKeys.list(tenantId, filters);

  const list = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) => fetchJobs(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: JobPage) => last.next,
    enabled: tenantId !== null,
  });

  const stream = useEventStream(tenantId ? jobsEventsPath(filters.queue) : null, (event) => {
    for (const job of jobsOfEvent(event)) {
      patchDetail(queryClient, tenantId, job);
      let known = false;
      queryClient.setQueryData<InfiniteData<JobPage, string | null>>(listKey, (data) => {
        if (!data) {
          return data;
        }
        const pages = replaceJobInPages(data.pages, job);
        known = pages !== null;
        return pages ? { ...data, pages } : data;
      });
      // A new job (or one that now matches the filter) belongs somewhere in the order.
      if (!known && matchesFilters(job, filters)) {
        invalidate(listKey);
      }
    }
  });

  const jobs = React.useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );
  return { list, jobs, stream };
}

// --- Detail -------------------------------------------------------------------

/** One job with its failures, kept live over the job's own stream until it ends. */
export function useLiveJob(jobId: string) {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const invalidate = useDebouncedInvalidate();
  const detailKey = jobKeys.detail(tenantId, jobId);

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => fetchJob(jobId),
    enabled: tenantId !== null,
  });

  const following = detail.data !== undefined && isLive(detail.data.status);
  const stream = useEventStream(following ? jobEventsPath(jobId) : null, (event) => {
    if (event.event === "end") {
      // The final state brings the result, the snapshot and every failure.
      invalidate(detailKey);
      void queryClient.invalidateQueries({ queryKey: jobKeys.objects(tenantId) });
      return;
    }
    for (const job of jobsOfEvent(event)) {
      const previous = queryClient.getQueryData<JobDetail>(detailKey);
      patchDetail(queryClient, tenantId, job);
      if (previous && (job.progress?.failed ?? 0) !== previous.failureCount) {
        invalidate(detailKey);
      }
    }
  });

  return { detail, stream: following ? stream : null };
}

// --- Backup targets -----------------------------------------------------------

/** Protected objects with last job and snapshot, kept live over the backup stream. */
export function useLiveBackupTargets() {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const invalidate = useDebouncedInvalidate();
  const objectsKey = jobKeys.objects(tenantId);

  const targets = useQuery({
    queryKey: objectsKey,
    queryFn: fetchBackupTargets,
    enabled: tenantId !== null,
  });

  const stream = useEventStream(tenantId ? jobsEventsPath("backup") : null, (event) => {
    for (const job of jobsOfEvent(event)) {
      queryClient.setQueryData<BackupTarget[]>(objectsKey, (data) =>
        data ? (withLatestJob(data, job) ?? data) : data,
      );
      // A finished backup changes the last snapshot (and may queue a verify).
      if (job.status === "completed") {
        invalidate(objectsKey);
      }
    }
  });

  return { targets, stream };
}

export function useSnapshotHistory(objectId: string | null, includePruned: boolean) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: jobKeys.snapshots(tenantId, objectId ?? "", includePruned),
    queryFn: () => fetchSnapshotHistory(objectId ?? "", includePruned),
    enabled: tenantId !== null && objectId !== null,
  });
}

// --- Actions ------------------------------------------------------------------

function useInvalidateJobs() {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: jobKeys.all(tenantId) });
}

export function useStartBackup() {
  const invalidateJobs = useInvalidateJobs();
  return useMutation({
    mutationFn: startBackup,
    onSettled: () => invalidateJobs(),
  });
}

export function useCancelJob() {
  const invalidateJobs = useInvalidateJobs();
  return useMutation({
    mutationFn: cancelJob,
    onSettled: () => invalidateJobs(),
  });
}

export function useRetryJob() {
  const invalidateJobs = useInvalidateJobs();
  return useMutation({
    mutationFn: retryJob,
    onSettled: () => invalidateJobs(),
  });
}
