import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useLiveOpen } from "@/features/history/live/provider";
import {
  type BackupTarget,
  cancelJob,
  fetchBackupTargets,
  fetchSnapshotHistory,
  jobKeys,
  retryJob,
  startBackup,
} from "@/features/jobs/api";
import { useSession } from "@/lib/session";

/**
 * Data hooks for what the older job pages still read: the protected objects with their last job,
 * the snapshot history and the actions on a job. None of them opens a stream: the live channel
 * (features/history/live) is the one connection of the tab, and it writes into these queries'
 * caches; while it is not connected they poll, as before it existed.
 */

function useTenantId(): string | null {
  const { activeTenant, status } = useSession();
  return status === "authenticated" ? (activeTenant?.id ?? null) : null;
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

// --- Backup targets -----------------------------------------------------------

/** How often the objects are asked for while the live channel is not connected. */
export const TARGETS_REFRESH_MS = 8_000;

/** Protected objects with last job and snapshot, kept live by the channel (polled while it is down). */
export function useLiveBackupTargets() {
  const tenantId = useTenantId();
  const connected = useLiveOpen();
  const targets = useQuery({
    queryKey: jobKeys.objects(tenantId),
    queryFn: fetchBackupTargets,
    enabled: tenantId !== null,
    refetchInterval: connected ? false : TARGETS_REFRESH_MS,
  });
  return { targets };
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
