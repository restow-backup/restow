import { Camera } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, RestoreTimeline } from "@/components/kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import "@/features/endpoints/i18n";
import {
  type Selection,
  effectiveFileCount,
  selectionLimits,
  toggleAll,
  toggleItem,
} from "@/features/endpoints/presenters";

import { type FileSourceAdapter, type RestorePointView, newestFirst } from "./adapter.js";
import { BrowserBody, type FolderPages, PathBar, SelectionBar } from "./file-browser.js";

const NO_SELECTION: Selection = new Map();

/**
 * The restore points beside the files of the chosen one: a third for the timeline (at least
 * 15rem), two thirds for the files, so paths and names keep their room. Inside a file restore
 * page, whose source list takes a quarter, the files get half the width.
 */
export const SNAPSHOTS_GRID = "lg:grid-cols-[minmax(15rem,1fr)_minmax(0,2fr)]";

/**
 * The restore points of a source and a browser for the files in one of them (docs/FILESHARES.md
 * 12.4). Ticked files and folders can be downloaded as a ZIP or restored the way the source
 * restores (the adapter's dialog). Every browse and download is audited by the server.
 */
export function RestorePointBrowser<P extends RestorePointView>({
  adapter,
}: {
  adapter: FileSourceAdapter<P>;
}) {
  const { t } = useTranslation("endpoints");
  const points = adapter.useRestorePoints();
  const [pointId, setPointId] = React.useState<string | null>(null);
  const [path, setPath] = React.useState("/");
  const [selection, setSelection] = React.useState<Selection>(NO_SELECTION);
  const [restoring, setRestoring] = React.useState(false);
  const list = React.useMemo(() => newestFirst(points.data ?? []), [points.data]);
  const point = list.find((item) => item.id === pointId) ?? null;
  const folder = adapter.useFolder(point?.id ?? null, path);
  const createDownload = adapter.useCreateDownload();
  // The pages fetched so far, joined: the server already lists them in order.
  const pages: FolderPages | undefined = folder.data
    ? {
        path,
        entries: folder.data.pages.flatMap((page) => page.entries),
        hasMore: folder.hasNextPage,
        loadingMore: folder.isFetchNextPageError ? false : folder.isFetchingNextPage,
        moreError: folder.isFetchNextPageError ? folder.error : null,
        onLoadMore: () => void folder.fetchNextPage(),
      }
    : undefined;

  const limits = selectionLimits(selection, adapter.limits);

  // Two steps: the server checks the selection and prepares the ZIP, then the browser is sent
  // to its address and saves it while it streams in.
  const download = () => {
    if (!point || limits.paths.length === 0 || limits.downloadBlocked) {
      return;
    }
    createDownload.mutate(
      { snapshotId: point.id, paths: limits.paths },
      {
        onSuccess: (prepared) => adapter.startDownload(adapter.downloadUrl(prepared.id)),
        onError: (error) =>
          toast.error(t("browser.selection.download.failed"), {
            description: t(adapter.errorKey(error)),
          }),
      },
    );
  };

  const pick = (next: P) => {
    if (next.id === pointId) {
      return;
    }
    setPointId(next.id);
    setPath("/");
    setSelection(NO_SELECTION);
  };

  if (points.isError) {
    return (
      <ErrorState
        title={
          adapter.isRetryable(points.error) ? t("snapshots.busyTitle") : t("snapshots.errorTitle")
        }
        description={t(adapter.errorKey(points.error))}
        error={points.error}
        onRetry={() => void points.refetch()}
        retrying={points.isFetching}
      />
    );
  }
  if (points.isPending) {
    return (
      <div className={`grid gap-4 ${SNAPSHOTS_GRID}`} aria-busy="true">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <EmptyState icon={Camera} title={adapter.emptyTitle} description={adapter.emptyDescription} />
    );
  }

  return (
    <div className={`grid items-start gap-4 ${SNAPSHOTS_GRID}`}>
      <Card className="gap-0 overflow-hidden py-0" data-slot="snapshots-card">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base">{t("snapshots.title")}</CardTitle>
          <CardDescription>{t("snapshots.description", { count: list.length })}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <RestoreTimeline
            items={list}
            idOf={(item: P) => item.id}
            timeOf={(item: P) => item.time}
            selectedId={pointId}
            onSelect={pick}
            renderDetails={adapter.renderDetails}
            label={adapter.timelineLabel}
            slot="snapshot-list"
          />
        </CardContent>
      </Card>

      <Card className="min-w-0 gap-0 overflow-hidden py-0" data-slot="browser-card">
        {point ? (
          <>
            <CardHeader className="gap-2 border-b py-4">
              <CardTitle className="text-base">
                {t("browser.title", { id: point.shortId })}
              </CardTitle>
              <CardDescription>{t("browser.auditNote")}</CardDescription>
              {adapter.renderBrowserExtra?.(point, (next) => {
                setPath(next);
              })}
              <PathBar
                path={path}
                onNavigate={(next) => {
                  setPath(next);
                }}
              />
            </CardHeader>
            <CardContent className="p-0">
              <BrowserBody
                loading={folder.isPending}
                error={folder.isError && !folder.isFetchNextPageError ? folder.error : null}
                onRetry={() => void folder.refetch()}
                retrying={folder.isFetching}
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
              canRestore={adapter.canRestore && !limits.restoreBlocked}
              onClear={() => setSelection(NO_SELECTION)}
              onDownload={download}
              onRestore={() => setRestoring(true)}
              limits={adapter.limits}
              restoreLabel={adapter.restoreLabel}
            />
            {adapter.note ? (
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">{adapter.note}</p>
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

      {point
        ? adapter.renderRestoreDialog({
            open: restoring,
            onOpenChange: setRestoring,
            point,
            paths: limits.paths,
            onRequested: () => setSelection(NO_SELECTION),
          })
        : null}
    </div>
  );
}
