import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type ScheduleUpdateInput,
  type UpdateSettingsInput,
  type UpdatesView,
  cancelMaintenance,
  checkForUpdates,
  dismissRun,
  fetchUpdates,
  patchUpdateSettings,
  removePendingLicenseKey,
  scheduleUpdate,
  storePendingLicenseKey,
  switchToFullBuild,
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
};

/** While a maintenance is announced or running the tab follows it closely. */
export const ACTIVE_REFRESH_MS = 3_000;

/** How often the tab refetches, given what it last saw; `false` while nothing is going on. */
export function updatesRefetchInterval(view: UpdatesView | undefined): number | false {
  return view && isMaintenanceActive(view.maintenance.phase) ? ACTIVE_REFRESH_MS : false;
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

export function useCancelMaintenance() {
  const write = useViewWriter();
  return useMutation({ mutationFn: cancelMaintenance, onSuccess: write });
}

export function useDismissRun() {
  const write = useViewWriter();
  return useMutation({ mutationFn: dismissRun, onSuccess: write });
}
