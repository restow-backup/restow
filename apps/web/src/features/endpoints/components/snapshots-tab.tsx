import { Link } from "@tanstack/react-router";

import { StatusBadge } from "@/components/kit";
import { MissingDataFoldersNotice } from "@/features/backup-jobs/components/missing-data-folders";
import { jobDefinitionTo, linkProps } from "@/features/backup-jobs/paths";
import type { FileSourceAdapter } from "@/features/restore/files/adapter";
import {
  RestorePointBrowser,
  SNAPSHOTS_GRID,
} from "@/features/restore/files/restore-point-browser";
import { RestorePointContents } from "@/features/restore/files/restore-point-contents";
import { RestorePointImmutabilityBadge } from "@/features/storage/components/restore-point-immutability";
import { SnapshotVerificationBadge } from "@/features/verify/components/snapshot-verification-badge";

import { type EndpointDetail, type EndpointSnapshot, endpointDownloadUrl, LIMITS } from "../api.js";
import { startBrowserDownload } from "../browser-download.js";
import {
  useBrowse,
  useCreateDownload,
  useEndpointFormat,
  useSnapshots,
  useTenantScope,
} from "../hooks.js";
import { endpointErrorKey, endpointName, isRetryableProblem } from "../presenters.js";
import { RestoreDialog } from "./restore-dialog.js";

/** Newest snapshot first. */
export function newestFirst(snapshots: readonly EndpointSnapshot[]): EndpointSnapshot[] {
  return [...snapshots].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

/**
 * What a machine's restore point shows below its time on the timeline: its files,
 * what it contains and what it added to the repository (#58, the same wording as
 * a Proxmox VE guest's).
 */
export function SnapshotDetails({
  snapshot,
  endpointId,
}: {
  snapshot: EndpointSnapshot;
  /** Set: the restore point's immutability is asked of its storage and shown. */
  endpointId?: string;
}) {
  const format = useEndpointFormat();
  const { t } = format;
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <code className="font-mono">{snapshot.shortId}</code>
        {snapshot.totalFilesProcessed !== null ? (
          <span>{t("snapshots.files", { count: snapshot.totalFilesProcessed })}</span>
        ) : null}
        {snapshot.totalBytesProcessed !== null ? (
          <span className="tabular-nums" title={t("snapshots.containsHint")}>
            {t("snapshots.contains", { size: format.bytes(snapshot.totalBytesProcessed) })}
          </span>
        ) : null}
        {snapshot.dataAdded !== null && snapshot.dataAdded !== undefined ? (
          <span className="tabular-nums" title={t("snapshots.addedHint")}>
            {t("snapshots.added", { size: format.bytes(snapshot.dataAdded) })}
          </span>
        ) : null}
      </span>
      {snapshot.paths.length > 0 ? (
        <span
          className="truncate font-mono text-xs text-muted-foreground"
          title={snapshot.paths.join(", ")}
        >
          {snapshot.paths.join(", ")}
        </span>
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: only keeps the badge's events from reaching the row's own handlers */}
      <span
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <SnapshotVerificationBadge
          verification={{ ...snapshot.verification, reportId: null }}
          focusable={false}
        />
      </span>
      {endpointId ? (
        <RestorePointImmutabilityBadge snapshotId={snapshot.id} endpointId={endpointId} />
      ) : null}
      {snapshot.flags.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5" data-slot="snapshot-flags">
          {snapshot.flags.map((flag) => (
            <StatusBadge key={flag} tone="destructive" icon>
              {t(`snapshots.flags.${flag}`)}
            </StatusBadge>
          ))}
          <span className="text-xs text-muted-foreground">{t("snapshots.flags.hint")}</span>
        </span>
      ) : null}
    </>
  );
}

/**
 * Why a folder may be missing from a machine's restore point (#59): only the folders of its
 * backup job are backed up. With a job, the way to its folders; without one, that it is in none.
 */
export function JobFoldersHint({ job }: { job: EndpointDetail["job"] }) {
  const { t } = useEndpointFormat();
  if (!job) {
    return <>{t("browser.contents.noJobHint")}</>;
  }
  return (
    <>
      {t("browser.contents.jobHint")}{" "}
      <Link
        {...linkProps(jobDefinitionTo(job.id, "endpoint", "scope"))}
        className="font-medium text-foreground underline underline-offset-2"
      >
        {t("browser.contents.editJob")}
      </Link>
    </>
  );
}

export { SNAPSHOTS_GRID };

/**
 * The restore points of a machine and a browser for the files in one of them
 * (features/restore/files, with the machine's adapter). Ticked files and folders can be
 * downloaded as a ZIP or restored onto the machine into a new folder. Every browse and download
 * is audited.
 */
export function SnapshotsTab({
  detail,
  onShowOverview,
}: {
  detail: EndpointDetail;
  onShowOverview: () => void;
}) {
  const { t } = useEndpointFormat();
  const { tenantId } = useTenantScope();
  const adapter: FileSourceAdapter<EndpointSnapshot> = {
    // Method syntax: the adapter's use* members are hooks, called at the browser's top level.
    useRestorePoints() {
      return useSnapshots(detail.id, true);
    },
    useFolder(snapshotId, path) {
      return useBrowse(detail.id, snapshotId, path);
    },
    useCreateDownload() {
      return useCreateDownload(detail.id);
    },
    downloadUrl: (downloadId) => endpointDownloadUrl(detail.id, downloadId, tenantId),
    startDownload: startBrowserDownload,
    limits: { downloadPaths: LIMITS.downloadPaths, restorePaths: LIMITS.restorePaths },
    canRestore: detail.status === "active",
    note: detail.status !== "active" ? t("browser.revokedNote") : undefined,
    timelineLabel: t("snapshots.timelineLabel", { name: endpointName(detail) }),
    suspicion: {
      target: { kind: "endpoint", objectId: detail.id },
      objectName: endpointName(detail),
    },
    emptyTitle: t("snapshots.empty.title"),
    emptyDescription: t("snapshots.empty.description"),
    renderDetails: (snapshot) => <SnapshotDetails snapshot={snapshot} endpointId={detail.id} />,
    // What the restore point holds, and why a folder may be missing (#59). A Windows path
    // (C:\Users) is not a folder of restic's tree, so only Linux and macOS paths open.
    renderBrowserExtra: (snapshot, openPath) => (
      <>
        <RestorePointContents
          paths={snapshot.paths}
          onOpen={detail.os === "windows" ? undefined : openPath}
          hint={<JobFoldersHint job={detail.job ?? null} />}
        />
        {detail.os === "linux" ? (
          <MissingDataFoldersNotice paths={snapshot.paths} context="restorePoint" />
        ) : null}
      </>
    ),
    renderRestoreDialog: (props) => (
      <RestoreDialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        endpoint={detail}
        snapshot={props.point}
        paths={props.paths}
        onShowOverview={onShowOverview}
        onRequested={props.onRequested}
      />
    ),
    errorKey: endpointErrorKey,
    isRetryable: isRetryableProblem,
  };
  return <RestorePointBrowser adapter={adapter} />;
}
