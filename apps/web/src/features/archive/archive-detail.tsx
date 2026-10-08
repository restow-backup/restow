import { Download, MailOpen } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState, RelativeTime } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ReadingPaneView } from "@/features/restore/explorer/reading-pane";

import { type ArchiveItem, type ArchiveSource, archiveItemDownloadUrl } from "./api.js";
import { useArchiveItem, useArchivePreview, useTenantScope } from "./hooks.js";

export interface ArchiveDetailProps {
  itemId: string | null;
  sourceLabel: (source: ArchiveSource | undefined, view: "list" | "detail") => string;
}

/**
 * One archived message: the sanitised content (the restore explorer's reading
 * pane, fed from the archive's audited preview), the `.eml` download and the
 * archive's own facts (hash, source, retention, flags). Nothing is read until
 * a message is chosen, since every read is audited.
 */
export const ArchiveDetail = React.forwardRef<HTMLElement, ArchiveDetailProps>(
  function ArchiveDetail({ itemId, sourceLabel }, ref) {
    const { t } = useTranslation("archive");
    const { tenantId } = useTenantScope();
    const item = useArchiveItem(itemId);
    const preview = useArchivePreview(itemId);

    return (
      <section
        ref={ref}
        aria-labelledby="archive-detail-title"
        className="@container min-w-0 space-y-4 rounded-md border p-4"
        data-slot="archive-detail"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="archive-detail-title" className="font-medium">
            {t("detail.title")}
          </h3>
          {itemId ? (
            <a
              href={archiveItemDownloadUrl(itemId, tenantId)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              data-slot="archive-download"
            >
              <Download aria-hidden="true" />
              {t("detail.download")}
            </a>
          ) : null}
        </div>

        {itemId === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <MailOpen className="size-4" aria-hidden="true" />
            {t("detail.empty")}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{t("detail.downloadHint")}</p>
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">{t("detail.content")}</h4>
              {preview.isPending ? (
                <div className="space-y-2" aria-busy="true">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : preview.isError ? (
                <ErrorState
                  title={t("detail.previewError")}
                  error={preview.error}
                  onRetry={() => void preview.refetch()}
                  retrying={preview.isFetching}
                />
              ) : preview.data?.headers ? (
                <ReadingPaneView
                  snapshotId=""
                  entryId={itemId}
                  tenantId={tenantId}
                  preview={preview.data}
                  attachmentHref={null}
                  attachmentsNote={t("detail.attachmentsNote")}
                />
              ) : null}
            </div>
            <div className="space-y-2">
              <h4 className="text-sm font-semibold">{t("detail.metadata")}</h4>
              {item.isPending ? (
                <div className="space-y-2" aria-busy="true">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : item.isError ? (
                <ErrorState
                  title={t("detail.loadError")}
                  error={item.error}
                  onRetry={() => void item.refetch()}
                  retrying={item.isFetching}
                />
              ) : (
                <ArchiveFacts item={item.data} sourceLabel={sourceLabel} />
              )}
            </div>
          </>
        )}
      </section>
    );
  },
);

function ArchiveFacts({
  item,
  sourceLabel,
}: {
  item: ArchiveItem;
  sourceLabel: ArchiveDetailProps["sourceLabel"];
}) {
  const { t, i18n } = useTranslation("archive");
  return (
    <dl className="space-y-1 text-sm">
      <div>
        <dt className="text-muted-foreground">{t("detail.messageId")}</dt>
        <dd className="break-all">{item.envelope?.messageId ?? "—"}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t("detail.itemHash")}</dt>
        <dd className="break-all font-mono text-xs">{item.itemHash}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t("detail.source")}</dt>
        <dd>{sourceLabel(item.source, "detail")}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t("detail.retentionUntil")}</dt>
        <dd>
          {item.retentionUntil ? (
            <RelativeTime value={item.retentionUntil} />
          ) : (
            t("detail.unlimited")
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t("detail.flags")}</dt>
        <dd className="flex flex-wrap gap-1">
          {item.flags.length === 0
            ? t("detail.noFlags")
            : item.flags.map((flag) => (
                <Badge key={flag} variant="secondary">
                  {i18n.exists(`archive:flags.${flag}`)
                    ? t(`flags.${flag}`)
                    : t("detail.flagUnknown", { code: flag })}
                </Badge>
              ))}
        </dd>
      </div>
    </dl>
  );
}
