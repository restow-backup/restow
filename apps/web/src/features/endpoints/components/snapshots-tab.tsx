import { StatusBadge } from "@/components/kit";
import type { FileSourceAdapter } from "@/features/restore/files/adapter";
import {
  RestorePointBrowser,
  SNAPSHOTS_GRID,
} from "@/features/restore/files/restore-point-browser";
import { SnapshotVerificationBadge } from "@/features/verify/components/snapshot-verification-badge";

import { type EndpointDetail, type EndpointSnapshot, LIMITS, endpointDownloadUrl } from "../api.js";
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

/** What a machine's restore point shows below its time on the timeline. */
function SnapshotDetails({ snapshot }: { snapshot: EndpointSnapshot }) {
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
          <span>{format.bytes(snapshot.totalBytesProcessed)}</span>
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
      <span
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <SnapshotVerificationBadge
          verification={{ ...snapshot.verification, reportId: null }}
          focusable={false}
        />
      </span>
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

const renderSnapshot = (snapshot: EndpointSnapshot) => <SnapshotDetails snapshot={snapshot} />;

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
    useRestorePoints: () => useSnapshots(detail.id, true),
    useFolder: (snapshotId, path) => useBrowse(detail.id, snapshotId, path),
    useCreateDownload: () => useCreateDownload(detail.id),
    downloadUrl: (downloadId) => endpointDownloadUrl(detail.id, downloadId, tenantId),
    startDownload: startBrowserDownload,
    limits: { downloadPaths: LIMITS.downloadPaths, restorePaths: LIMITS.restorePaths },
    canRestore: detail.status === "active",
    note: detail.status !== "active" ? t("browser.revokedNote") : undefined,
    timelineLabel: t("snapshots.timelineLabel", { name: endpointName(detail) }),
    emptyTitle: t("snapshots.empty.title"),
    emptyDescription: t("snapshots.empty.description"),
    renderDetails: renderSnapshot,
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
