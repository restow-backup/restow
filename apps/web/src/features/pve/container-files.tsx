import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { ErrorState } from "@/components/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { LIMITS } from "@/features/endpoints/api";
import { useEndpointFormat, useTenantScope } from "@/features/endpoints/hooks";
import { endpointErrorKey, isRetryableProblem } from "@/features/endpoints/presenters";
import type { FileSourceAdapter, RestorePointView } from "@/features/restore/files/adapter";
import { startBrowserDownload } from "@/features/restore/files/browser-download";
import { RestorePointBrowser } from "@/features/restore/files/restore-point-browser";
import { RestorePointContents } from "@/features/restore/files/restore-point-contents";
import { ApiError } from "@/lib/api";

import {
  containerDownloadUrl,
  createContainerDownload,
  fetchContainerFiles,
  fetchGuest,
  type PveGuestDetail,
  type PveRestorePoint,
  pveKeys,
} from "./api.js";
import { guestTo } from "./paths.js";

/** A container restore point as the timeline and the file browser show it. */
export interface ContainerPoint extends RestorePointView {
  /** What it holds, as paths in the container (`/` and the mount points vzdump includes). */
  contents: readonly string[];
  byteSize: number;
  added: number | null;
}

/**
 * The restore points of a container whose files can be browsed, newest first. A restore point
 * from a server before 0.4.0 says nothing about it: a container's is browsable, holding `/`.
 */
export function containerPoints(
  detail: Pick<PveGuestDetail, "snapshots">,
  label: (time: string) => string,
): ContainerPoint[] {
  return detail.snapshots
    .filter((point: PveRestorePoint) => point.browsable ?? point.kind === "ct")
    .map((point) => ({
      id: point.id,
      time: point.backupAt,
      shortId: label(point.backupAt),
      contents: point.contents ?? ["/"],
      byteSize: point.byteSize,
      added: point.added ?? null,
    }));
}

/** The name a container goes by: its name in PVE, else "CT <vmid>". */
export function containerName(guest: { vmid: number; name: string | null }): string {
  return guest.name ?? `CT ${guest.vmid}`;
}

function ContainerPointDetails({ point }: { point: ContainerPoint }) {
  const format = useEndpointFormat();
  const { t } = format;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular-nums" title={t("snapshots.containsHint")}>
        {t("snapshots.contains", { size: format.bytes(point.byteSize) })}
      </span>
      {point.added !== null ? (
        <span className="tabular-nums" title={t("snapshots.addedHint")}>
          {t("snapshots.added", { size: format.bytes(point.added) })}
        </span>
      ) : null}
    </span>
  );
}

const renderPoint = (point: ContainerPoint) => <ContainerPointDetails point={point} />;

/**
 * The restore points of a Proxmox VE container and a browser for the files in one of them (#62):
 * the same timeline, folder list and ZIP download as for a machine (features/restore/files). The
 * server reads the container's restic repository; every folder and download is audited. Files are
 * only downloaded: a container is put back as a whole under VMs & containers.
 */
export function ContainerRestorePoints({ guestId }: { guestId: string }) {
  const format = useEndpointFormat();
  const { t } = format;
  const { tenantId, enabled } = useTenantScope();
  const guest = useQuery({
    queryKey: pveKeys.guest(tenantId, guestId),
    queryFn: () => fetchGuest(guestId),
    enabled,
    retry: false,
  });
  const name = guest.data ? containerName(guest.data.guest) : "";

  const adapter: FileSourceAdapter<ContainerPoint> = {
    // Method syntax: the adapter's use* members are hooks, called at the browser's top level.
    useRestorePoints() {
      return useQuery({
        queryKey: pveKeys.guest(tenantId, guestId),
        queryFn: () => fetchGuest(guestId),
        enabled,
        retry: false,
        select: (detail) => containerPoints(detail, (time) => format.dateTime(time) ?? time),
      });
    },
    useFolder(pointId, path) {
      return useInfiniteQuery({
        queryKey: pveKeys.files(tenantId, pointId ?? "", path),
        queryFn: ({ pageParam }) => fetchContainerFiles(pointId ?? "", path, pageParam),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor,
        enabled: enabled && pointId !== null,
        retry: false,
        // A restore point never changes, and each read is audited and starts restic.
        staleTime: 10 * 60_000,
      });
    },
    useCreateDownload() {
      return useMutation({
        mutationFn: (input: { snapshotId: string; paths: readonly string[] }) =>
          createContainerDownload(input.snapshotId, input.paths),
      });
    },
    downloadUrl: (downloadId, point) => containerDownloadUrl(point.id, downloadId, tenantId),
    startDownload: startBrowserDownload,
    limits: { downloadPaths: LIMITS.downloadPaths, restorePaths: LIMITS.restorePaths },
    canRestore: false,
    note: (
      <>
        {t("containerFiles.downloadOnly")}{" "}
        <Link
          {...guestTo(guestId)}
          className="font-medium text-foreground underline underline-offset-2"
        >
          {t("containerFiles.openGuest")}
        </Link>
      </>
    ),
    timelineLabel: t("containerFiles.timelineLabel", { name }),
    suspicion: { target: { kind: "pve_guest", objectId: guestId }, objectName: name },
    emptyTitle: t("containerFiles.emptyTitle"),
    emptyDescription: t("containerFiles.emptyDescription"),
    renderDetails: renderPoint,
    // The whole root file system is backed up: what it holds, and no hint about a job's folders.
    renderBrowserExtra: (point, openPath) => (
      <RestorePointContents
        paths={point.contents}
        onOpen={openPath}
        labelOf={(path) => (path === "/" ? t("browser.contents.wholeContainer") : path)}
      />
    ),
    errorKey: endpointErrorKey,
    isRetryable: isRetryableProblem,
  };

  if (guest.isError) {
    const missing = guest.error instanceof ApiError && guest.error.status === 404;
    return (
      <ErrorState
        title={missing ? t("containerFiles.notFound") : t("containerFiles.loadError")}
        description={missing ? t("containerFiles.notFoundDescription") : undefined}
        error={guest.error}
        onRetry={missing ? undefined : () => void guest.refetch()}
        retrying={guest.isFetching}
      />
    );
  }
  if (!guest.data) {
    return <Skeleton className="h-64 w-full" aria-busy="true" />;
  }
  return <RestorePointBrowser adapter={adapter} />;
}
