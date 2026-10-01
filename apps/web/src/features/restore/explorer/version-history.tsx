import { Download, Eye, Layers, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  Snapshot,
  SnapshotObject,
  StoredVersion,
  TreeEntry,
  Version,
} from "@/features/restore/api";
import { isShownVersion } from "@/features/restore/lib/versions";
import { useVersions } from "@/features/restore/use-restore-data";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface VersionHistoryProps {
  object: SnapshotObject;
  entry: TreeEntry;
  snapshot: Snapshot;
  /** Browse the snapshot that holds this version. */
  onShow: (version: Version) => void;
  onRestore: (version: Version, target: "original" | "download") => void;
  /** Download a version the source kept (OneDrive). */
  onDownloadStored: (version: StoredVersion) => void;
}

/**
 * How an item looked in each backup, newest first: identical content across
 * consecutive backups is one version, a deletion is a version of its own.
 * Any version can be shown, restored or downloaded.
 */
export function VersionHistory({
  object,
  entry,
  snapshot,
  onShow,
  onRestore,
  onDownloadStored,
}: VersionHistoryProps) {
  const { t, i18n } = useTranslation("restore");
  const { t: tCommon } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const versions = useVersions(object.id, entry, snapshot.id);

  return (
    <section aria-labelledby="restore-versions-title" className="space-y-3">
      <div className="space-y-1">
        <h3 id="restore-versions-title" className="flex items-center gap-2 text-sm font-semibold">
          <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("versions.title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("versions.description")}</p>
      </div>

      {versions.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : versions.isError ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-destructive">{t("versions.loadError")}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void versions.refetch()}
            loading={versions.isFetching}
          >
            {tCommon("actions.retry")}
          </Button>
        </div>
      ) : (
        <>
          <ol className="space-y-2">
            {versions.data.versions.map((version) => {
              const shown = isShownVersion(version, snapshot);
              return (
                <li
                  key={version.snapshotId}
                  className={cn(
                    "space-y-2 rounded-md border border-border p-3",
                    shown && "border-primary/60 bg-primary/5",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium tabular-nums">
                      {formatDateTime(version.snapshotAt, language) ??
                        t("versions.sequence", { sequence: version.sequence })}
                    </span>
                    {shown ? <Badge variant="outline">{t("versions.shown")}</Badge> : null}
                    {version.deleted ? (
                      <Badge variant="muted">{t("versions.deleted")}</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {[
                      version.snapshotCount > 1
                        ? t("versions.seenIn", {
                            count: version.snapshotCount,
                            first: formatDateTime(version.firstSeenAt, language) ?? "",
                          })
                        : t("versions.seenOnce"),
                      version.deleted ? null : formatBytes(version.size, language),
                      version.deleted || !version.mtime
                        ? null
                        : t("versions.modified", { date: formatDateTime(version.mtime, language) }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {version.deleted ? (
                    <p className="text-xs text-muted-foreground">{t("versions.deletedHint")}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {shown ? null : (
                        <Button variant="ghost" size="sm" onClick={() => onShow(version)}>
                          <Eye />
                          {t("versions.show")}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onRestore(version, "original")}
                      >
                        <RotateCcw />
                        {t("versions.restore")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRestore(version, "download")}
                      >
                        <Download />
                        {t("versions.download")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {versions.data.versions.length <= 1 ? (
            <p className="text-xs text-muted-foreground">{t("versions.onlyOne")}</p>
          ) : null}

          {versions.data.stored.length > 0 ? (
            <StoredVersions
              versions={versions.data.stored}
              language={language}
              onDownload={onDownloadStored}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function StoredVersions({
  versions,
  language,
  onDownload,
}: {
  versions: StoredVersion[];
  language: string;
  onDownload: (version: StoredVersion) => void;
}) {
  const { t } = useTranslation("restore");
  return (
    <section aria-labelledby="restore-stored-versions-title" className="space-y-2 pt-2">
      <h4 id="restore-stored-versions-title" className="text-sm font-semibold">
        {t("versions.stored.title")}
      </h4>
      <p className="text-xs text-muted-foreground">{t("versions.stored.description")}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {versions.map((version) => (
          <li key={version.path} className="flex items-center gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {t("versions.stored.version", { version: version.versionId })}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {[
                  formatDateTime(version.modifiedAt, language),
                  version.modifiedBy,
                  formatBytes(version.size, language),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onDownload(version)}
              aria-label={t("versions.stored.download", { version: version.versionId })}
            >
              <Download />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
