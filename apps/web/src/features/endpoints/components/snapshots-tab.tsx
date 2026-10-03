import { Camera } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, RestoreTimeline, StatusBadge } from "@/components/kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SnapshotVerificationBadge } from "@/features/verify/components/snapshot-verification-badge";

import { toast } from "@/components/ui/sonner";

import { type EndpointDetail, type EndpointSnapshot, LIMITS, endpointDownloadUrl } from "../api.js";
import { startBrowserDownload } from "../browser-download.js";
import {
  useBrowse,
  useCreateDownload,
  useEndpointFormat,
  useSnapshots,
  useTenantScope,
} from "../hooks.js";
import {
  type Selection,
  effectiveFileCount,
  endpointErrorKey,
  endpointName,
  isRetryableProblem,
  selectionLimits,
  toggleAll,
  toggleItem,
} from "../presenters.js";
import { BrowserBody, type FolderPages, PathBar, SelectionBar } from "./file-browser.js";
import { RestoreDialog } from "./restore-dialog.js";

const NO_SELECTION: Selection = new Map();

/** Newest snapshot first. */
export function newestFirst(snapshots: readonly EndpointSnapshot[]): EndpointSnapshot[] {
  return [...snapshots].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

const idOfSnapshot = (snapshot: EndpointSnapshot) => snapshot.id;
const timeOfSnapshot = (snapshot: EndpointSnapshot) => snapshot.time;

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

/**
 * The restore points of a machine and a browser for the files in one of them.
 * Ticked files and folders can be downloaded as a ZIP or restored onto the
 * machine into a new folder. Every browse and download is audited.
 */
export function SnapshotsTab({
  detail,
  onShowOverview,
}: {
  detail: EndpointDetail;
  onShowOverview: () => void;
}) {
  const format = useEndpointFormat();
  const { t } = format;
  const { tenantId } = useTenantScope();
  const snapshots = useSnapshots(detail.id, true);
  const [snapshotId, setSnapshotId] = React.useState<string | null>(null);
  const [path, setPath] = React.useState("/");
  const [selection, setSelection] = React.useState<Selection>(NO_SELECTION);
  const [restoring, setRestoring] = React.useState(false);

  const list = React.useMemo(() => newestFirst(snapshots.data ?? []), [snapshots.data]);
  const snapshot = list.find((item) => item.id === snapshotId) ?? null;
  const browse = useBrowse(detail.id, snapshot?.id ?? null, path);
  const createDownload = useCreateDownload(detail.id);
  // The pages fetched so far, joined: the server already lists them in order.
  const pages: FolderPages | undefined = browse.data
    ? {
        path,
        entries: browse.data.pages.flatMap((page) => page.entries),
        hasMore: browse.hasNextPage,
        loadingMore: browse.isFetchNextPageError ? false : browse.isFetchingNextPage,
        moreError: browse.isFetchNextPageError ? browse.error : null,
        onLoadMore: () => void browse.fetchNextPage(),
      }
    : undefined;

  const limits = selectionLimits(selection, {
    downloadPaths: LIMITS.downloadPaths,
    restorePaths: LIMITS.restorePaths,
  });

  // Two steps: the server checks the selection and prepares the ZIP, then the
  // browser is sent to its address and saves it while it streams in.
  const download = () => {
    if (!snapshot || limits.paths.length === 0 || limits.downloadBlocked) {
      return;
    }
    createDownload.mutate(
      { snapshotId: snapshot.id, paths: limits.paths },
      {
        onSuccess: (prepared) =>
          startBrowserDownload(endpointDownloadUrl(detail.id, prepared.id, tenantId)),
        onError: (error) =>
          toast.error(t("browser.selection.download.failed"), {
            description: t(endpointErrorKey(error)),
          }),
      },
    );
  };

  const pick = (next: EndpointSnapshot) => {
    if (next.id === snapshotId) {
      return;
    }
    setSnapshotId(next.id);
    setPath("/");
    setSelection(NO_SELECTION);
  };

  if (snapshots.isError) {
    return (
      <ErrorState
        title={
          isRetryableProblem(snapshots.error) ? t("snapshots.busyTitle") : t("snapshots.errorTitle")
        }
        description={t(endpointErrorKey(snapshots.error))}
        error={snapshots.error}
        onRetry={() => void snapshots.refetch()}
        retrying={snapshots.isFetching}
      />
    );
  }
  if (snapshots.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]" aria-busy="true">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <EmptyState
        icon={Camera}
        title={t("snapshots.empty.title")}
        description={t("snapshots.empty.description")}
      />
    );
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Card className="gap-0 overflow-hidden py-0" data-slot="snapshots-card">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base">{t("snapshots.title")}</CardTitle>
          <CardDescription>{t("snapshots.description", { count: list.length })}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <RestoreTimeline
            items={list}
            idOf={idOfSnapshot}
            timeOf={timeOfSnapshot}
            selectedId={snapshotId}
            onSelect={pick}
            renderDetails={renderSnapshot}
            label={t("snapshots.timelineLabel", { name: endpointName(detail) })}
            slot="snapshot-list"
          />
        </CardContent>
      </Card>

      <Card className="min-w-0 gap-0 overflow-hidden py-0" data-slot="browser-card">
        {snapshot ? (
          <>
            <CardHeader className="gap-2 border-b py-4">
              <CardTitle className="text-base">
                {t("browser.title", { id: snapshot.shortId })}
              </CardTitle>
              <CardDescription>{t("browser.auditNote")}</CardDescription>
              <PathBar
                path={path}
                onNavigate={(next) => {
                  setPath(next);
                }}
              />
            </CardHeader>
            <CardContent className="p-0">
              <BrowserBody
                loading={browse.isPending}
                error={browse.isError && !browse.isFetchNextPageError ? browse.error : null}
                onRetry={() => void browse.refetch()}
                retrying={browse.isFetching}
                pages={pages}
                selection={selection}
                onToggle={(entry) => setSelection((current) => toggleItem(current, entry))}
                onToggleAll={(entries) => setSelection((current) => toggleAll(current, entries))}
                onOpenFolder={setPath}
              />
            </CardContent>
            <SelectionBar
              count={limits.paths.length}
              singleFiles={effectiveFileCount(selection)}
              blockedDownload={limits.downloadBlocked}
              blockedRestore={limits.restoreBlocked}
              downloading={createDownload.isPending}
              canRestore={detail.status === "active" && !limits.restoreBlocked}
              onClear={() => setSelection(NO_SELECTION)}
              onDownload={download}
              onRestore={() => setRestoring(true)}
            />
            {detail.status !== "active" ? (
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                {t("browser.revokedNote")}
              </p>
            ) : null}
          </>
        ) : (
          <CardContent className="py-16">
            <EmptyState
              variant="plain"
              icon={Camera}
              title={t("browser.pick.title")}
              description={t("browser.pick.description")}
            />
          </CardContent>
        )}
      </Card>

      {snapshot ? (
        <RestoreDialog
          open={restoring}
          onOpenChange={setRestoring}
          endpoint={detail}
          snapshot={snapshot}
          paths={limits.paths}
          onShowOverview={onShowOverview}
          onRequested={() => setSelection(NO_SELECTION)}
        />
      ) : null}
    </div>
  );
}
