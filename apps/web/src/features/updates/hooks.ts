import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  cancelMaintenance,
  checkForUpdates,
  dismissRun,
  fetchJobActivity,
  fetchRestarts,
  fetchUpdates,
  patchUpdateSettings,
  type RestartService,
  type RestartsView,
  removePendingLicenseKey,
  restartService,
  type ScheduleUpdateInput,
  scheduleUpdate,
  startUpdateNow,
  storePendingLicenseKey,
  switchToFullBuild,
  type UpdateSettingsInput,
  type UpdatesView,
} from "./api";
import { isMaintenanceActive } from "./presenters";

/**
 * TanStack Query wiring of the Updates tab. The keys are not tenant scoped:
 * updates belong to the installation.
 */

export const updatesKeys = {
  view: ["updates", "view"] as const,
  /** The maintenance state every signed-in user polls (maintenance/use-maintenance.tsx). */
  maintenance: ["updates", "maintenance"] as const,
  /** Services that need a restart (the notice for provider admins and the Updates tab). */
  restarts: ["updates", "restarts"] as const,
  /** What runs and waits right now (the install dialog, #46). */
  jobs: ["updates", "jobs"] as const,
};

/** While a maintenance is announced or running the tab follows it closely. */
export const ACTIVE_REFRESH_MS = 3_000;

/** While an update waits for runs in progress the tab follows the counts. */
export const WAITING_REFRESH_MS = 10_000;

/** How often the tab refetches, given what it last saw; `false` while nothing is going on. */
export function updatesRefetchInterval(view: UpdatesView | undefined): number | false {
  if (view && isMaintenanceActive(view.maintenance.phase)) {
    return ACTIVE_REFRESH_MS;
  }
  return view?.jobPause?.phase === "draining" ? WAITING_REFRESH_MS : false;
}

export function useUpdates() {
  return useQuery({
    queryKey: updatesKeys.view,
    queryFn: fetchUpdates,
    staleTime: 15_000,
    refetchInterval: (query) => updatesRefetchInterval(query.state.data),
  });
}

/**
 * Store the fresh view every mutation answers with, and let the maintenance
 * state of the shell re-read at once (an announced update must show up in the
 * banner without waiting for the next poll).
 */
function useViewWriter() {
  const queryClient = useQueryClient();
  return (view: UpdatesView) => {
    queryClient.setQueryData(updatesKeys.view, view);
    void queryClient.invalidateQueries({ queryKey: updatesKeys.maintenance });
  };
}

export function useSaveUpdateSettings() {
  const write = useViewWriter();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => patchUpdateSettings(input),
    onSuccess: write,
  });
}

export function useCheckNow() {
  const write = useViewWriter();
  return useMutation({ mutationFn: checkForUpdates, onSuccess: write });
}

export function useScheduleUpdate() {
  const write = useViewWriter();
  return useMutation({
    mutationFn: (input: ScheduleUpdateInput) => scheduleUpdate(input),
    onSuccess: write,
  });
}

export function useSwitchToFullBuild() {
  const write = useViewWriter();
  return useMutation({
    mutationFn: (input: { leadSeconds: number }) => switchToFullBuild(input),
    onSuccess: write,
  });
}

export function useStorePendingLicenseKey() {
  const write = useViewWriter();
  return useMutation({
    mutationFn: (key: string) => storePendingLicenseKey(key),
    onSuccess: write,
  });
}

export function useRemovePendingLicenseKey() {
  const write = useViewWriter();
  return useMutation({ mutationFn: removePendingLicenseKey, onSuccess: write });
}

/** What runs and waits right now; read while the install dialog is open. */
export function useJobActivity(enabled: boolean) {
  return useQuery({
    queryKey: updatesKeys.jobs,
    queryFn: fetchJobActivity,
    enabled,
    staleTime: 0,
    refetchInterval: enabled ? WAITING_REFRESH_MS : false,
  });
}

/** An update that waits for runs in progress: announce it now. */
export function useStartUpdateNow() {
  const write = useViewWriter();
  return useMutation({ mutationFn: startUpdateNow, onSuccess: write });
}

export function useCancelMaintenance() {
  const write = useViewWriter();
  return useMutation({ mutationFn: cancelMaintenance, onSuccess: write });
}

export function useDismissRun() {
  const write = useViewWriter();
  return useMutation({ mutationFn: dismissRun, onSuccess: write });
}

/** How often the open restart requests are read again: rarely, closely while a restart takes effect. */
export const RESTARTS_IDLE_REFRESH_MS = 60_000;
export const RESTARTS_QUIET_REFRESH_MS = 5 * 60_000;
export const RESTARTS_ACTIVE_REFRESH_MS = 5_000;

/** After a restart finished, the restarted service clears its notice when it is up; watch that long. */
const SETTLE_MS = 3 * 60_000;

export function restartsRefetchInterval(
  view: RestartsView | undefined,
  nowMs: number = Date.now(),
): number | false {
  if (!view) {
    return false;
  }
  if (view.requests.length === 0) {
    // Any process may ask for a restart at any time; nobody waits for it to the second.
    return RESTARTS_QUIET_REFRESH_MS;
  }
  const last = view.lastRestart;
  const settling =
    last !== null &&
    last.status !== "failed" &&
    view.requests.some((request) => request.service === last.service) &&
    (last.finishedAt === null || nowMs - Date.parse(last.finishedAt) < SETTLE_MS);
  return settling ? RESTARTS_ACTIVE_REFRESH_MS : RESTARTS_IDLE_REFRESH_MS;
}

/** The open restart requests; only for provider admins (`enabled`), whom the API answers. */
export function useRestarts(enabled = true) {
  return useQuery({
    queryKey: updatesKeys.restarts,
    queryFn: fetchRestarts,
    enabled,
    staleTime: 15_000,
    refetchInterval: (query) => restartsRefetchInterval(query.state.data),
  });
}

export function useRestartService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (service: RestartService) => restartService(service),
    onSuccess: (view) => queryClient.setQueryData(updatesKeys.restarts, view),
  });
}
