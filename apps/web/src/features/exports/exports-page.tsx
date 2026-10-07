import { Link } from "@tanstack/react-router";
import {
  Archive as ArchiveIcon,
  ArchiveRestore,
  ChevronRight,
  FileDown,
  RefreshCw,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/kit";
import { OlderEntries } from "@/components/kit/older-entries";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ARCHIVE_PATH } from "@/features/archive/paths";
import type { MailExport } from "@/features/exports/api";
import {
  CancelExportButton,
  DownloadExportButton,
} from "@/features/exports/components/export-actions";
import { ExportStatusBadge } from "@/features/exports/components/export-status-badge";
import {
  downloadState,
  expiryMessage,
  expiryOf,
  isLive,
  needsClock,
} from "@/features/exports/lib/exports";
import { exportHref, useOpenExport } from "@/features/exports/navigation";
import { useExportText } from "@/features/exports/use-export-text";
import { useClock, useExports } from "@/features/exports/use-exports-data";
import { ProgressBar } from "@/features/restore/components/progress-bar";
import { ObjectIcon } from "@/features/restore/explorer/entry-icon";
import { progressRatio } from "@/features/restore/lib/jobs";
import { RESTORE_PATHS, restoreTo } from "@/features/restore/navigation";
import { formatBytes, formatDateTime, formatInteger, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";

/**
 * Every export the viewer may see, newest first: what it was made from, its
 * format, progress while it runs, and for finished ones the size, how long
 * the download link still works and the download itself.
 */
export function ExportsPage() {
  const { t } = useTranslation("exports");
  const { t: tCommon } = useTranslation();
  const { isProviderAdmin, activeTenant } = useSession();
  const canExportArchive = isProviderAdmin || activeTenant?.role === "tenant_admin";
  const [pages, setPages] = React.useState(1);
  const exports = useExports(pages);

  const sources = (
    <>
      <Link to={restoreTo(RESTORE_PATHS.explorer)} className={buttonVariants({ size: "sm" })}>
        <ArchiveRestore />
        {t("list.fromBackups")}
      </Link>
      {canExportArchive ? (
        <Link
          to={restoreTo(ARCHIVE_PATH)}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ArchiveIcon />
          {t("list.fromArchive")}
        </Link>
      ) : null}
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("list.title")}
        description={
          exports.data?.ttlHours
            ? t("list.subtitleHours", { count: exports.data.ttlHours })
            : t("list.subtitle")
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void exports.refetch()}
          disabled={exports.isFetching}
        >
          <RefreshCw className={exports.isFetching ? "animate-spin" : undefined} />
          {tCommon("actions.refresh")}
        </Button>
      </PageHeader>

      {exports.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : exports.isError ? (
        <ErrorState
          title={t("list.loadError")}
          error={exports.error}
          onRetry={() => void exports.refetch()}
          retrying={exports.isFetching}
        />
      ) : exports.data.items.length === 0 ? (
        <EmptyState
          icon={FileDown}
          title={t("list.empty")}
          // The archive is for administrators only: do not point anyone else there.
          description={t(canExportArchive ? "list.emptyDescription" : "list.emptyDescriptionUser")}
          actions={sources}
        />
      ) : (
        <Card className="gap-0 py-0">
          <ExportsTable items={exports.data.items} />
          <OlderEntries
            shownLabel={t("list.shown", { count: exports.data.items.length })}
            moreLabel={t("list.showOlder")}
            hasMore={exports.data.hasMore}
            loading={exports.isFetching && exports.isPlaceholderData}
            onMore={() => setPages((current) => current + 1)}
          />
        </Card>
      )}
    </div>
  );
}

function ExportsTable({ items }: { items: MailExport[] }) {
  const { t, i18n } = useTranslation("exports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const text = useExportText();
  const openExport = useOpenExport();
  // The clock only ticks while some finished export still has a countdown.
  const now = useClock(
    items.some((item) => needsClock(item)),
    30_000,
  );

  return (
    <Table scrollLabel={t("list.title")}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead pin={PIN_FIRST}>{t("list.columns.created")}</TableHead>
          <TableHead className="hidden sm:table-cell">{t("list.columns.origin")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("list.columns.format")}</TableHead>
          <TableHead>{t("list.columns.status")}</TableHead>
          <TableHead className="hidden text-right lg:table-cell">
            {t("list.columns.size")}
          </TableHead>
          <TableHead className="hidden xl:table-cell">{t("list.columns.expires")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">
            <span className="sr-only">{t("list.columns.actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const ratio = progressRatio(item.progress);
          return (
            <TableRow key={item.id} className="cursor-pointer" onClick={() => openExport(item.id)}>
              <TableCell pin={PIN_FIRST} className="whitespace-nowrap">
                <Link
                  to={exportHref(item.id)}
                  onClick={(event) => event.stopPropagation()}
                  className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={formatDateTime(item.createdAt, language) ?? undefined}
                >
                  {formatRelative(item.createdAt, language)}
                </Link>
                <p className="text-xs text-muted-foreground">{text.actor(item.actor)}</p>
                <p className="max-w-40 truncate text-xs text-muted-foreground sm:hidden">
                  {text.source(item)}
                </p>
              </TableCell>
              <TableCell className="hidden w-[28%] max-w-0 sm:table-cell">
                <div className="flex min-w-0 items-center gap-2">
                  {item.object ? (
                    <ObjectIcon kind={item.object.kind} />
                  ) : (
                    <ArchiveIcon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <span className="truncate">{text.source(item)}</span>
                  {item.impersonated ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("adminExport")}
                    </Badge>
                  ) : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">{text.selection(item)}</p>
              </TableCell>
              <TableCell className="hidden whitespace-nowrap md:table-cell">
                {text.formatShort(item.format)}
              </TableCell>
              <TableCell className="min-w-40">
                <div className="space-y-1.5">
                  <ExportStatusBadge item={item} />
                  {isLive(item) ? (
                    <>
                      <ProgressBar
                        ratio={item.status === "queued" ? 0 : ratio}
                        label={t("progress.label")}
                        tone={(item.progress?.failed ?? 0) > 0 ? "destructive" : "default"}
                      />
                      {item.progress && item.progress.total > 0 ? (
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {t("progress.count", {
                            done: formatInteger(item.progress.done, language),
                            total: formatInteger(item.progress.total, language),
                          })}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                  {item.status === "completed" ? (
                    <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground sm:hidden">
                      {item.fileSize !== null ? (
                        <span>{formatBytes(item.fileSize, language)}</span>
                      ) : null}
                      <ExpiryCell item={item} now={now} />
                    </p>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="hidden whitespace-nowrap text-right tabular-nums lg:table-cell">
                {item.fileSize !== null && item.status === "completed"
                  ? formatBytes(item.fileSize, language)
                  : ""}
              </TableCell>
              <TableCell className="hidden whitespace-nowrap text-sm xl:table-cell">
                <ExpiryCell item={item} now={now} />
              </TableCell>
              <TableCell className="hidden whitespace-nowrap text-right sm:table-cell">
                <div className="flex items-center justify-end gap-2">
                  <DownloadExportButton item={item} now={now} />
                  <CancelExportButton item={item} />
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** When the download link runs out, or that it already has. */
function ExpiryCell({ item, now }: { item: MailExport; now: number }) {
  const { t } = useTranslation("exports");
  const state = downloadState(item, now);
  if (state === "expired") {
    return <span className="text-muted-foreground">{t("list.expired")}</span>;
  }
  if (state !== "ready") {
    return null;
  }
  const message = expiryMessage(expiryOf(item.expiresAt, now), "short");
  return message ? <span>{t(message.key, message.values)}</span> : null;
}
