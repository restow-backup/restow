import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  type CreateRestoreRequest,
  DEFAULT_TREE_SORT,
  type RestoreJob,
  type Tree,
  type TreeEntry,
  type TreeSort,
  cancelRestoreJob,
  createRestore,
  fetchEntryPreview,
  fetchRestoreJob,
  fetchRestoreJobs,
  fetchRestoreTargets,
  fetchSnapshotObjects,
  fetchSnapshots,
  fetchTree,
  fetchVersions,
  restoreKeys,
  searchSnapshot,
} from "@/features/restore/api";
import { isLive } from "@/features/restore/lib/jobs";
import { fetchPages } from "@/lib/paged-list";
import { useSession } from "@/lib/session";

/**
 * Data hooks for the explorer and the restore jobs. Every key carries the
 * active tenant, and nothing runs before the session is settled.
 */

function useTenantScope() {
  const { status, activeTenant } = useSession();
  return { tenantId: activeTenant?.id ?? null, enabled: status === "authenticated" };
}

/** Snapshots are immutable once committed; browsing data may be cached generously. */
const SNAPSHOT_DATA_STALE_MS = 5 * 60_000;

/**
 * Every account the viewer may browse. `includeAll` also lists accounts
 * excluded from protection or without a restore point yet, for the
 * explorer's account list.
 */
export function useSnapshotObjects(includeAll = false) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: restoreKeys.objects(tenantId, includeAll),
    queryFn: () => fetchSnapshotObjects(includeAll),
    enabled,
  });
}

export function useSnapshots(objectId: string | null) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: restoreKeys.snapshots(tenantId, objectId),
    queryFn: () => fetchSnapshots(objectId as string),
    enabled: enabled && objectId !== null,
  });
}

/** The children of one folder, page by page (large mail folders), folders first. */
export function useTree(
  snapshotId: string | null,
  path: string,
  sort: TreeSort = DEFAULT_TREE_SORT,
) {
  const { tenantId, enabled } = useTenantScope();
  const query = useInfiniteQuery({
    queryKey: restoreKeys.tree(tenantId, snapshotId, path, sort),
    queryFn: ({ pageParam }) => fetchTree(snapshotId as string, path, { offset: pageParam, sort }),
    initialPageParam: 0,
    getNextPageParam: (last: Tree) =>
      last.hasMore ? last.offset + last.entries.length : undefined,
    enabled: enabled && snapshotId !== null,
    staleTime: SNAPSHOT_DATA_STALE_MS,
  });
  const pages = query.data?.pages ?? [];
  const entries: TreeEntry[] = pages.flatMap((page) => page.entries);
  return { ...query, tree: pages[0], entries, total: pages[0]?.total ?? 0 };
}

/** The subfolders of one folder, for the folder tree. */
export function useFolders(snapshotId: string | null, path: string, enabled = true) {
  const scope = useTenantScope();
  return useQuery({
    queryKey: restoreKeys.folders(scope.tenantId, snapshotId, path),
    queryFn: () => fetchTree(snapshotId as string, path, { foldersOnly: true }),
    enabled: scope.enabled && enabled && snapshotId !== null,
    staleTime: SNAPSHOT_DATA_STALE_MS,
  });
}

export function useVersions(
  objectId: string | null,
  entry: Pick<TreeEntry, "path" | "itemId" | "kind"> | null,
  snapshotId: string | null,
) {
  const { tenantId, enabled } = useTenantScope();
  const path = entry?.path ?? "";
  const itemId = entry?.itemId ?? null;
  return useQuery({
    queryKey: restoreKeys.versions(tenantId, objectId, path, itemId, snapshotId),
    queryFn: () => fetchVersions(objectId as string, path, itemId, snapshotId),
    enabled: enabled && objectId !== null && entry !== null && entry.kind !== "folder",
  });
}

/** The reading pane's content for one mail entry; `null` while nothing is open. */
export function useEntryPreview(snapshotId: string | null, entryId: string | null) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: restoreKeys.preview(tenantId, snapshotId, entryId),
    queryFn: () => fetchEntryPreview(snapshotId as string, entryId as string),
    enabled: enabled && snapshotId !== null && entryId !== null,
    staleTime: SNAPSHOT_DATA_STALE_MS,
  });
}

/** Search within a snapshot; `query` is null while there is nothing to search for. */
export function useSnapshotSearch(snapshotId: string | null, query: string | null) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: restoreKeys.search(tenantId, snapshotId, query ?? ""),
    queryFn: () => searchSnapshot(snapshotId as string, query as string),
    enabled: enabled && snapshotId !== null && query !== null,
    placeholderData: keepPreviousData,
    staleTime: SNAPSHOT_DATA_STALE_MS,
  });
}

/** Suggestions for "restore into another account" (tenant admins only). */
export function useRestoreTargets(objectId: string | null, enabled: boolean) {
  const scope = useTenantScope();
  return useQuery({
    queryKey: restoreKeys.targets(scope.tenantId, objectId),
    queryFn: () => fetchRestoreTargets(objectId as string),
    enabled: scope.enabled && enabled && objectId !== null,
  });
}

export function useCreateRestore() {
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  return useMutation({
    mutationFn: (request: CreateRestoreRequest) => createRestore(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: restoreKeys.jobs(tenantId) });
    },
  });
}

/** Poll quickly while anything is queued or running, slowly otherwise. */
export const LIVE_POLL_MS = 3_000;
export const IDLE_POLL_MS = 30_000;

/** Restores per page of the "Recent restores" list. */
export const RESTORE_JOBS_PAGE = 100;

/** The newest `pages` pages of restores, and whether older ones exist. */
export function useRestoreJobs(pages = 1) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: [...restoreKeys.jobs(tenantId), pages],
    queryFn: () =>
      fetchPages((offset) => fetchRestoreJobs(RESTORE_JOBS_PAGE, offset), RESTORE_JOBS_PAGE, pages),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.items.some((job: RestoreJob) => isLive(job)) ? LIVE_POLL_MS : IDLE_POLL_MS,
  });
}

export function useRestoreJob(restoreId: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: restoreKeys.job(tenantId, restoreId),
    queryFn: () => fetchRestoreJob(restoreId),
    enabled,
    refetchInterval: (query) =>
      query.state.data && isLive(query.state.data) ? LIVE_POLL_MS : false,
  });
}

export function useCancelRestore() {
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  return useMutation({
    mutationFn: (restoreId: string) => cancelRestoreJob(restoreId),
    onSuccess: (detail) => {
      queryClient.setQueryData(restoreKeys.job(tenantId, detail.id), detail);
      void queryClient.invalidateQueries({ queryKey: restoreKeys.jobs(tenantId) });
    },
  });
}

/** The active tenant id, for URLs that cannot carry the tenant header (downloads). */
export function useActiveTenantId(): string | null {
  return useTenantScope().tenantId;
}
