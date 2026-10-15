import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/lib/session";

import {
  fetchObjectSuspicions,
  fetchOpenSuspicions,
  fetchRansomwareSettings,
  markFalseAlarm,
  markHoldFalseAlarm,
  type RansomwareSettings,
  releaseRetentionHold,
  revokeFalseAlarm,
  type SuspicionTarget,
  saveRansomwareSettings,
  suspicionKeys,
} from "./api";
import { mayMarkFalseAlarm, mayReadSuspicions, mayReleaseHold } from "./presenters";

/** The active tenant, whether the judgements may be read, and whether a false alarm may be marked. */
export function useSuspicionScope() {
  const session = useSession();
  return {
    tenantId: session.activeTenant?.id ?? null,
    enabled:
      session.status === "authenticated" &&
      session.activeTenant !== null &&
      mayReadSuspicions(session),
    canMarkFalseAlarm: mayMarkFalseAlarm(session),
    canReleaseHold: mayReleaseHold(session),
  };
}

/**
 * The judgements of one object's restore points. Nothing is asked for without a target or for a
 * viewer who may not read them; an error leaves the restore views as they were (no badges).
 */
export function useObjectSuspicions(target: SuspicionTarget | null | undefined) {
  const { tenantId, enabled } = useSuspicionScope();
  return useQuery({
    queryKey: target
      ? suspicionKeys.object(tenantId, target)
      : (["tenant", tenantId, "suspicions", "none"] as const),
    queryFn: () => fetchObjectSuspicions(target as SuspicionTarget),
    enabled: enabled && Boolean(target),
    retry: false,
    // A new restore point is judged within minutes of its backup.
    refetchInterval: 2 * 60_000,
  });
}

/** The tenant's objects whose newest restore point is suspicious. */
export function useOpenSuspicions() {
  const { tenantId, enabled } = useSuspicionScope();
  return useQuery({
    queryKey: suspicionKeys.open(tenantId),
    queryFn: fetchOpenSuspicions,
    enabled,
    retry: false,
    refetchInterval: 2 * 60_000,
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  const { tenantId } = useSuspicionScope();
  return () => queryClient.invalidateQueries({ queryKey: suspicionKeys.all(tenantId) });
}

export function useMarkFalseAlarm() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string | null }) => markFalseAlarm(id, note),
    onSettled: refresh,
  });
}

export function useRevokeFalseAlarm() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => revokeFalseAlarm(id),
    onSettled: refresh,
  });
}

export function useReleaseRetentionHold() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ target, note }: { target: SuspicionTarget; note: string | null }) =>
      releaseRetentionHold(target, note),
    onSettled: refresh,
  });
}

export function useMarkHoldFalseAlarm() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ target, note }: { target: SuspicionTarget; note: string | null }) =>
      markHoldFalseAlarm(target, note),
    onSettled: refresh,
  });
}

export function useRansomwareSettings() {
  return useQuery({ queryKey: suspicionKeys.settings, queryFn: fetchRansomwareSettings });
}

export function useSaveRansomwareSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: Partial<RansomwareSettings>) => saveRansomwareSettings(settings),
    onSuccess: (view) => queryClient.setQueryData(suspicionKeys.settings, view),
  });
}
