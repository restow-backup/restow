import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useSession } from "@/lib/session";

import {
  type RetentionPolicyInput,
  type RetentionPolicyPatch,
  type RetentionPreviewRequest,
  createRetentionPolicy,
  deleteRetentionPolicy,
  fetchRetentionPolicies,
  previewRetentionPolicy,
  retentionKeys,
  searchScopeCandidates,
  updateRetentionPolicy,
} from "./api.js";

/**
 * Data hooks of the retention page. Every key carries the active tenant,
 * nothing runs before the session is settled, and every change refreshes the
 * list.
 */

/** Wait this long after the last keystroke before asking for a preview. */
const PREVIEW_DEBOUNCE_MS = 400;

export function useTenantScope() {
  const { status, activeTenant, isProviderAdmin } = useSession();
  return {
    tenantId: activeTenant?.id ?? null,
    enabled: status === "authenticated" && activeTenant !== null,
    /** Retention shapes what backup data survives, so only administrators reach it at all. */
    canManage: isProviderAdmin || activeTenant?.role === "tenant_admin",
  };
}

export function useRetentionPolicies() {
  const { tenantId, enabled, canManage } = useTenantScope();
  return useQuery({
    queryKey: retentionKeys.list(tenantId),
    queryFn: fetchRetentionPolicies,
    // The API is tenant-administrator only; a plain tenant user would just
    // get a 403 back, so the page shows its own explanation instead of
    // asking at all (see RetentionPage).
    enabled: enabled && canManage,
  });
}

function useInvalidateRetention() {
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: retentionKeys.all(tenantId) });
}

export function useCreateRetentionPolicy() {
  const invalidate = useInvalidateRetention();
  return useMutation({
    mutationFn: (input: RetentionPolicyInput) => createRetentionPolicy(input),
    onSettled: invalidate,
  });
}

export function useUpdateRetentionPolicy() {
  const invalidate = useInvalidateRetention();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: RetentionPolicyPatch }) =>
      updateRetentionPolicy(id, patch),
    onSettled: invalidate,
  });
}

export function useDeleteRetentionPolicy() {
  const invalidate = useInvalidateRetention();
  return useMutation({
    mutationFn: (id: string) => deleteRetentionPolicy(id),
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
 * What the next retention run would remove for the draft being edited, asked
 * from the API (the same @restow/core function the worker runs). `null` asks
 * for nothing. The previous answer stays on screen while the next one loads,
 * so the preview does not flicker while the administrator is still typing.
 *
 * `isCurrent` is the one field a caller must check before trusting `data`
 * for anything higher-stakes than display, such as deciding whether saving
 * needs a confirmation: it is true only once the query key matches `request`
 * exactly (the debounce settled) *and* the fetch for that exact key finished
 * successfully — `keepPreviousData` otherwise leaves the previous draft's
 * result on screen (`isPlaceholderData`) while the new one is still loading,
 * which is not the same thing as an answer for the current draft.
 */
export function useRetentionPreview(request: RetentionPreviewRequest | null) {
  const { tenantId, enabled } = useTenantScope();
  const debounced = useDebouncedValue(request, PREVIEW_DEBOUNCE_MS);
  const settled = debounced !== null && JSON.stringify(debounced) === JSON.stringify(request);
  const query = useQuery({
    queryKey: retentionKeys.preview(
      tenantId,
      debounced ?? { preset: "keep_all", protectedObjectIds: null },
    ),
    queryFn: () => previewRetentionPolicy(debounced as RetentionPreviewRequest),
    enabled: enabled && settled,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 15_000,
  });
  return { ...query, isCurrent: settled && query.isSuccess && !query.isPlaceholderData };
}

/** Protected objects a policy can be narrowed to, searched as the administrator types. */
export function useScopeCandidates(search: string, open: boolean) {
  const { tenantId, enabled } = useTenantScope();
  const debounced = useDebouncedValue(search, 250);
  return useQuery({
    queryKey: retentionKeys.scope(tenantId, debounced),
    queryFn: () => searchScopeCandidates(debounced),
    enabled: enabled && open,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
