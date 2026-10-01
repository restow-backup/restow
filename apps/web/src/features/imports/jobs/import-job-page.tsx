import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Ban, Hourglass } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useJobFormat } from "@/features/jobs/use-format";
import { Fact, Facts } from "@/features/restore/components/facts";
import { ProgressBar } from "@/features/restore/components/progress-bar";
import { ApiError } from "@/lib/api";
import { formatBytes, formatDateTime, formatInteger } from "@/lib/format";
import { ImportsForbidden, NoTenantSelected } from "../components/access-states";
import { ImportStatusBadge } from "../components/status-badge";
import { IMPORT_PATHS, importTo } from "../paths";
import { alreadyImportedCount, isLive, phaseKey, progressRatio } from "../presenters";
import type { ImportDetail } from "../types";
import { useImportDetail } from "../use-imports";
import { ItemsCard } from "./items-card";
import { CancelImportButton, DownloadReportButton, OpenInExplorerLink } from "./job-actions";
import { ArchiveCard, FilesCard, NotesAlert, ReportCards } from "./report-view";

/**
 * One import from request to result: live progress while it runs, then the
 * report with the numbers, the files, the honest notes and every item that
 * did not become a message, failed ones first.
 */
export function ImportJobPage({ importId }: { importId: string }) {
  const { t } = useTranslation("imports");
  const { query, tenantId, canManage } = useImportDetail(importId);

  const back = (
    <Link
      to={importTo(IMPORT_PATHS.list)}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <ArrowLeft />
      {t("job.back")}
    </Link>
  );

  if (!tenantId || !canManage) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("job.title")}>{back}</PageHeader>
        {tenantId ? <ImportsForbidden /> : <NoTenantSelected />}
      </div>
    );
  }
  if (query.isPending) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("job.title")}>{back}</PageHeader>
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-48 lg:col-span-2" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-6">
        <PageHeader title={t("job.title")}>{back}</PageHeader>
        {notFound ? (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertTitle>{t("job.notFound.title")}</AlertTitle>
            <AlertDescription>{t("job.notFound.description")}</AlertDescription>
          </Alert>
        ) : (
          <ErrorState
            title={t("job.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        )}
      </div>
    );
  }

  const detail = query.data;
  return (
    <div className="space-y-6">
      <PageHeader title={detail.name} description={t("job.subtitle")}>
        {back}
        <CancelImportButton job={detail} />
        <DownloadReportButton detail={detail} />
        <OpenInExplorerLink detail={detail} />
      </PageHeader>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {isLive(detail) ? <ProgressCard detail={detail} /> : <OutcomeCard detail={detail} />}
          {detail.report ? (
            <>
              <ReportCards report={detail.report} />
              <NotesAlert notes={detail.report.notes} />
              <ArchiveCard
                requested={detail.archive}
                archive={detail.report.archive}
                live={isLive(detail)}
              />
            </>
          ) : detail.archive ? (
            <ArchiveCard requested archive={null} live={isLive(detail)} />
          ) : null}
        </div>
        <RequestCard detail={detail} />
      </div>

      {/* The tables get the full width: the file table has many columns. */}
      <FilesCard detail={detail} />
      <ItemsCard detail={detail} />
    </div>
  );
}

function ProgressCard({ detail }: { detail: ImportDetail }) {
  const { t, i18n } = useTranslation("imports");
  const jobFormat = useJobFormat();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const progress = detail.progress;
  const live = detail.live ?? null;
  const ratio = detail.status === "queued" ? 0 : progressRatio(progress);
  const phase = phaseKey(detail.phase);
  const failed = progress?.failed ?? live?.failed ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("job.progress.title")}</CardTitle>
          <CardDescription>
            {detail.status === "queued"
              ? t("job.progress.queued")
              : phase
                ? t("job.progress.phase", { phase: t(phase) })
                : t("job.progress.running")}
          </CardDescription>
        </div>
        <ImportStatusBadge job={detail} />
      </CardHeader>
      <CardContent className="space-y-3">
        <ProgressBar
          ratio={ratio}
          label={t("job.progress.label")}
          tone={failed > 0 ? "destructive" : "default"}
        />
        {progress && progress.total > 0 ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
            <span>
              {t("job.progress.read", {
                done: formatBytes(progress.done, language),
                total: formatBytes(progress.total, language),
                percent: formatInteger(Math.floor((ratio ?? 0) * 100), language),
              })}
            </span>
            {live ? <span>{t("job.progress.messages", { count: live.messages })}</span> : null}
            {live && live.filesTotal > 1 ? (
              <span>
                {t("job.progress.file", {
                  current: Math.min(live.filesTotal, live.filesDone + 1),
                  total: live.filesTotal,
                })}
              </span>
            ) : null}
            {live?.archiveTotal ? (
              <span>
                {t("job.progress.archive", {
                  done: formatInteger(live.archiveDone ?? 0, language),
                  total: formatInteger(live.archiveTotal, language),
                })}
              </span>
            ) : null}
            {failed > 0 ? (
              <span className="text-destructive">
                {t("job.progress.failed", { count: failed })}
              </span>
            ) : null}
            {live && live.duplicates > 0 ? (
              <span className="text-muted-foreground">
                {t("job.progress.duplicates", { count: live.duplicates })}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              {t("job.progress.stored", { size: formatBytes(progress.bytes, language) })}
            </span>
            {progress.etaSeconds !== null ? (
              <span className="text-muted-foreground">
                {t("job.progress.eta", { duration: jobFormat.duration(progress.etaSeconds) })}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Hourglass className="size-4" aria-hidden="true" />
            {t(detail.status === "queued" ? "job.progress.waiting" : "job.progress.counting")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function OutcomeCard({ detail }: { detail: ImportDetail }) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const alreadyImported = alreadyImportedCount(detail.report);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("job.outcome.title")}</CardTitle>
          <CardDescription>
            {detail.completedAt
              ? t("job.outcome.finishedAt", { date: formatDateTime(detail.completedAt, language) })
              : t("job.outcome.notFinished")}
          </CardDescription>
        </div>
        <ImportStatusBadge job={detail} />
      </CardHeader>
      <CardContent className="space-y-3">
        {detail.status === "failed" ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t("job.outcome.failed")}</AlertTitle>
            <AlertDescription className="break-words">
              {detail.errorMessage ?? t("job.outcome.failedUnknown")}
            </AlertDescription>
          </Alert>
        ) : null}
        {detail.status === "cancelled" ? (
          <Alert variant="info">
            <Ban />
            <AlertTitle>{t("job.outcome.cancelled")}</AlertTitle>
            <AlertDescription>{t("job.outcome.cancelledDescription")}</AlertDescription>
          </Alert>
        ) : null}
        {detail.status === "completed" ? (
          <p className="text-sm text-muted-foreground">
            {detail.report?.snapshotId
              ? t("job.outcome.completedSnapshot")
              : alreadyImported !== null
                ? t("job.outcome.allAlreadyImported", { count: alreadyImported })
                : t("job.outcome.completedNoSnapshot")}
          </p>
        ) : null}
        {detail.status === "failed" && detail.report && !detail.report.snapshotId ? (
          <p className="text-sm text-muted-foreground">{t("job.outcome.nothingStored")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RequestCard({ detail }: { detail: ImportDetail }) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const jobFormat = useJobFormat();
  const started = detail.startedAt ? Date.parse(detail.startedAt) : Number.NaN;
  const ended = detail.completedAt ? Date.parse(detail.completedAt) : Number.NaN;
  const duration =
    Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? jobFormat.duration((ended - started) / 1000)
      : null;
  const actor = detail.actor.name ?? detail.actor.email;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("job.request.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Facts className="grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)]">
          <Fact label={t("job.request.mailbox")}>{detail.name}</Fact>
          <Fact label={t("job.request.files")}>
            {t("job.request.filesValue", { count: detail.fileCount })}
          </Fact>
          <Fact label={t("job.request.archive")}>
            {detail.archive ? t("review.archive.yes") : t("review.archive.no")}
          </Fact>
          {actor ? <Fact label={t("job.request.actor")}>{actor}</Fact> : null}
          <Fact label={t("job.request.requested")}>
            {formatDateTime(detail.createdAt, language)}
          </Fact>
          {detail.startedAt ? (
            <Fact label={t("job.request.started")}>
              {formatDateTime(detail.startedAt, language)}
            </Fact>
          ) : null}
          {detail.completedAt ? (
            <Fact label={t("job.request.finished")}>
              {formatDateTime(detail.completedAt, language)}
            </Fact>
          ) : null}
          {duration ? <Fact label={t("job.request.duration")}>{duration}</Fact> : null}
        </Facts>
      </CardContent>
    </Card>
  );
}
