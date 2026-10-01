import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useSession } from "@/lib/session";

import {
  type PreviewRequest,
  type ScheduleInput,
  type SchedulePatch,
  applyRecommendedSchedules,
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  previewSchedule,
  scheduleKeys,
  searchScopeCandidates,
  updateSchedule,
} from "./api.js";

/**
 * Data hooks of the schedules page. Every key carries the active tenant,
 * nothing runs before the session is settled, and every change refreshes the
 * list (next runs and missing recommendations are computed by the server).
 */

/** The list refreshes on its own, so next and last runs stay current while the page is open. */
const REFRESH_MS = 60_000;
/** Wait this long after the last keystroke before asking for a preview. */
const PREVIEW_DEBOUNCE_MS = 350;

export function useTenantScope() {
  const { status, activeTenant, isProviderAdmin } = useSession();
  return {
    tenantId: activeTenant?.id ?? null,
    enabled: status === "authenticated" && activeTenant !== null,
    /** Tenant administrators and provider admins change schedules; everyone else reads. */
    canManage: isProviderAdmin || activeTenant?.role === "tenant_admin",
  };
}

export function useSchedules() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: scheduleKeys.list(tenantId),
    queryFn: fetchSchedules,
    enabled,
    refetchInterval: REFRESH_MS,
  });
}

function useInvalidateSchedules() {
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: scheduleKeys.all(tenantId) });
}

export function useCreateSchedule() {
  const invalidate = useInvalidateSchedules();
  return useMutation({
    mutationFn: (input: ScheduleInput) => createSchedule(input),
    onSettled: invalidate,
  });
}

export function useUpdateSchedule() {
  const invalidate = useInvalidateSchedules();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SchedulePatch }) => updateSchedule(id, patch),
    onSettled: invalidate,
  });
}

export function useDeleteSchedule() {
  const invalidate = useInvalidateSchedules();
  return useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSettled: invalidate,
  });
}

export function useApplyRecommended() {
  const invalidate = useInvalidateSchedules();
  return useMutation({
    mutationFn: (timezone: string) => applyRecommendedSchedules(timezone),
    onSettled: invalidate,
  });
}

/** `value`, updated only after it stayed the same for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * The next five runs of the cadence being edited, asked from the API (the
 * same code the scheduler runs on). `null` asks for nothing. The previous
 * answer stays on screen while the next one loads, so the list does not jump.
 */
export function useSchedulePreview(request: PreviewRequest | null) {
  const { tenantId, enabled } = useTenantScope();
  const debounced = useDebouncedValue(request, PREVIEW_DEBOUNCE_MS);
  const settled = debounced !== null && JSON.stringify(debounced) === JSON.stringify(request);
  return useQuery({
    queryKey: scheduleKeys.preview(
      tenantId,
      debounced ?? { intervalMinutes: null, cron: null, timezone: "" },
    ),
    queryFn: () => previewSchedule(debounced as PreviewRequest),
    enabled: enabled && settled,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

/** Protected objects to narrow a schedule to, searched as the administrator types. */
export function useScopeCandidates(search: string, open: boolean) {
  const { tenantId, enabled } = useTenantScope();
  const debounced = useDebouncedValue(search, 250);
  return useQuery({
    queryKey: scheduleKeys.scope(tenantId, debounced),
    queryFn: () => searchScopeCandidates(debounced),
    enabled: enabled && open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
