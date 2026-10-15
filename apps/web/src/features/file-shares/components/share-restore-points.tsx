import { History, Search, ShieldCheck } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { endpointErrorKey, isRetryableProblem } from "@/features/endpoints/presenters";
import type { FileSourceAdapter } from "@/features/restore/files/adapter";
import { startBrowserDownload } from "@/features/restore/files/browser-download";
import { RestorePointBrowser } from "@/features/restore/files/restore-point-browser";
import { SnapshotVerificationBadge } from "@/features/verify/components/snapshot-verification-badge";

import { type FileShareDetail, LIMITS, type ShareSnapshot, shareDownloadUrl } from "../api.js";
import {
  type ShareFormat,
  useCreateShareDownload,
  useShareBrowse,
  useShareFormat,
  useShareSearch,
  useShareSnapshots,
  useShareVersions,
  useTenantScope,
} from "../hooks.js";
import { shareErrorKey } from "../presenters.js";
import { ShareRestoreDialog } from "./restore-dialog.js";

/** What a share's restore point shows below its time on the timeline. */
function PointDetails({ point, format }: { point: ShareSnapshot; format: ShareFormat }) {
  const { t } = format;
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <code className="font-mono">{point.shortId}</code>
        <span>{t("points.files", { count: point.files })}</span>
        <span>{format.bytes(point.bytes)}</span>
        {point.bytesAdded > 0 ? (
          <span>{t("points.added", { size: format.bytes(point.bytesAdded) })}</span>
        ) : null}
      </span>
      {point.includes.length > 0 ? (
        <span
          className="truncate font-mono text-xs text-muted-foreground"
          title={point.includes.join(", ")}
        >
          {point.includes.join(", ")}
        </span>
      ) : null}
      <span
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <SnapshotVerificationBadge
          verification={{ ...point.verification, reportId: null }}
          focusable={false}
        />
      </span>
    </>
  );
}

export interface ShareRestorePointsProps {
  share: FileShareDetail;
  onShowRuns: () => void;
}

/**
 * The restore points of a share with the file browser of restore points (features/restore/files,
 * docs/FILESHARES.md 12.4), the search over every restore point when the catalog exists, and the
 * version history of a file. Selected files and folders download as a ZIP or are restored into
 * this or another share.
 */
export function ShareRestorePoints({ share, onShowRuns }: ShareRestorePointsProps) {
  const format = useShareFormat();
  const { t } = format;
  const { tenantId } = useTenantScope();
  const points = useShareSnapshots(share.id);
  const createDownload = useCreateShareDownload(share.id);
  // A restore started from the search or the version history (outside the browser).
  const [direct, setDirect] = React.useState<{ point: ShareSnapshot; paths: string[] } | null>(
    null,
  );

  const download = (pointId: string, paths: readonly string[]) =>
    createDownload.mutate(
      { snapshotId: pointId, paths },
      {
        onSuccess: (prepared) =>
          startBrowserDownload(shareDownloadUrl(share.id, prepared.id, tenantId)),
        onError: (error) =>
          toast.error(t("points.downloadFailed"), { description: t(shareErrorKey(error)) }),
      },
    );

  const adapter: FileSourceAdapter<ShareSnapshot> = {
    useRestorePoints: () => points,
    useFolder: (pointId, path) => useShareBrowse(share.id, pointId, path),
    useCreateDownload: () => createDownload,
    downloadUrl: (downloadId) => shareDownloadUrl(share.id, downloadId, tenantId),
    startDownload: startBrowserDownload,
    limits: { downloadPaths: LIMITS.selectionPaths, restorePaths: LIMITS.selectionPaths },
    canRestore: true,
    restoreLabel: t("points.restore"),
    timelineLabel: t("points.timelineLabel", { name: share.name }),
    emptyTitle: t("points.empty.title"),
    emptyDescription: t("points.empty.description"),
    renderDetails: (point) => <PointDetails point={point} format={format} />,
    renderBrowserExtra: (point) =>
      point.permissions && point.permissions.mode !== "off" ? (
        <p
          className="flex items-center gap-1 text-xs text-muted-foreground"
          data-slot="permissions-note"
        >
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {t("points.permissions", { count: point.permissions.entries })}
        </p>
      ) : null,
    renderRestoreDialog: (props) => (
      <ShareRestoreDialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        share={share}
        point={props.point}
        paths={props.paths}
        onDownload={() => download(props.point.id, props.paths)}
        onRequested={props.onRequested}
        onShowRuns={onShowRuns}
      />
    ),
    errorKey: (error) => endpointErrorKey(error),
    isRetryable: isRetryableProblem,
  };

  const pointById = (id: string | null) =>
    (points.data ?? []).find((point) => point.id === id) ?? null;

  return (
    <div className="space-y-4" data-slot="share-restore-points">
      {share.catalog.at ? (
        <SearchCard
          share={share}
          format={format}
          onDownload={(pointId, path) => download(pointId, [path])}
          onRestore={(pointId, path) => {
            const point = pointById(pointId);
            if (point) setDirect({ point, paths: [path] });
          }}
        />
      ) : (points.data?.length ?? 0) > 0 ? (
        <p className="text-xs text-muted-foreground" data-slot="no-catalog">
          {t("search.unavailable")}
        </p>
      ) : null}
      <RestorePointBrowser adapter={adapter} />
      {direct ? (
        <ShareRestoreDialog
          open
          onOpenChange={(open) => !open && setDirect(null)}
          share={share}
          point={direct.point}
          paths={direct.paths}
          onDownload={() => download(direct.point.id, direct.paths)}
          onRequested={() => undefined}
          onShowRuns={onShowRuns}
        />
      ) : null}
    </div>
  );
}

function SearchCard({
  share,
  format,
  onDownload,
  onRestore,
}: {
  share: FileShareDetail;
  format: ShareFormat;
  onDownload: (pointId: string, path: string) => void;
  onRestore: (pointId: string, path: string) => void;
}) {
  const { t } = format;
  const [text, setText] = React.useState("");
  const [term, setTerm] = React.useState("");
  const [versionsOf, setVersionsOf] = React.useState<string | null>(null);
  const search = useShareSearch(share.id, term);
  const versions = useShareVersions(share.id, versionsOf);

  return (
    <Card data-slot="share-search">
      <CardHeader>
        <CardTitle className="text-base">{t("search.title")}</CardTitle>
        <CardDescription>{t("search.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setTerm(text.trim());
            setVersionsOf(null);
          }}
        >
          <Input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("search.placeholder")}
            aria-label={t("search.placeholder")}
          />
          <Button type="submit" variant="outline" disabled={text.trim().length < LIMITS.searchMin}>
            <Search aria-hidden="true" />
            {t("search.run")}
          </Button>
        </form>
        {search.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{t(shareErrorKey(search.error))}</AlertDescription>
          </Alert>
        ) : null}
        {search.data ? (
          search.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("search.none")}</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm" data-slot="search-hits">
              {search.data.items.map((hit) => (
                <li
                  key={hit.path}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block break-all font-mono text-xs">{hit.path}</span>
                    <span className="text-xs text-muted-foreground">
                      {format.bytes(hit.size)}
                      {hit.snapshotTime ? ` · ${format.dateTime(hit.snapshotTime)}` : ""}
                    </span>
                    {!hit.current ? (
                      <Badge variant="outline" className="ml-2">
                        {t("search.deleted")}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setVersionsOf(hit.path)}
                      data-action="versions"
                    >
                      <History aria-hidden="true" />
                      {t("search.versions")}
                    </Button>
                    {hit.snapshotId ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onDownload(hit.snapshotId as string, hit.path)}
                        >
                          {t("search.download")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onRestore(hit.snapshotId as string, hit.path)}
                        >
                          {t("search.restore")}
                        </Button>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : null}
        {versionsOf ? (
          <section className="space-y-2" data-slot="version-history">
            <h3 className="text-sm font-medium">{t("versions.title", { path: versionsOf })}</h3>
            {versions.data ? (
              <ul className="divide-y rounded-md border text-sm">
                {versions.data.items.map((version) => (
                  <li
                    key={version.firstSequence}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <span>
                      {format.bytes(version.size)}
                      {version.mtime
                        ? ` · ${t("versions.modified", { time: format.dateTime(version.mtime) ?? "" })}`
                        : ""}
                      <span className="block text-xs text-muted-foreground">
                        {version.since
                          ? t("versions.since", { time: format.dateTime(version.since) ?? "" })
                          : t("versions.pruned")}
                        {version.current ? ` · ${t("versions.current")}` : ""}
                      </span>
                    </span>
                    {version.snapshotId ? (
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onDownload(version.snapshotId as string, versionsOf)}
                        >
                          {t("search.download")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onRestore(version.snapshotId as string, versionsOf)}
                        >
                          {t("search.restore")}
                        </Button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : versions.isError ? (
              <p className="text-sm text-destructive-text">{t(shareErrorKey(versions.error))}</p>
            ) : null}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
