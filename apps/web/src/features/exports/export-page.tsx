import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Clock,
  FileArchive,
  Hourglass,
  Info,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { CopyButton } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { MailExportDetail } from "@/features/exports/api";
import {
  CancelExportButton,
  DownloadExportButton,
} from "@/features/exports/components/export-actions";
import { ExportStatusBadge } from "@/features/exports/components/export-status-badge";
import {
  downloadState,
  expiryMessage,
  expiryOf,
  failureRows,
  isLive,
  needsClock,
  phaseKey,
  skippedEntries,
} from "@/features/exports/lib/exports";
import { EXPORT_PATHS, exportsTo } from "@/features/exports/navigation";
import { useExportText } from "@/features/exports/use-export-text";
import { useClock, useExport } from "@/features/exports/use-exports-data";
import { Fact, Facts } from "@/features/restore/components/facts";
import { ProgressBar } from "@/features/restore/components/progress-bar";
import { ObjectIcon } from "@/features/restore/explorer/entry-icon";
import { etaMinutes, progressRatio } from "@/features/restore/lib/jobs";
import { formatBytes, formatDateTime, formatInteger } from "@/lib/format";

/**
 * One export from request to file: live progress while it runs, then the
 * result (the file, its checksum, how long the download link lasts), what
 * was left out because it is not mail, and every message that could not be
 * exported.
 */
export function ExportPage({ exportId }: { exportId: string }) {
  const { t } = useTranslation("exports");
  const query = useExport(exportId);
  const detail = query.data ?? null;
  // The clock only ticks while a download link has a countdown to show.
  const now = useClock(detail !== null && needsClock(detail));

  const back = (
    <Link
      to={exportsTo(EXPORT_PATHS.list)}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <ArrowLeft />
      {t("page.back")}
    </Link>
  );

  if (query.isPending) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("page.title")}>{back}</PageHeader>
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }
  if (query.isError || detail === null) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("page.title")}>{back}</PageHeader>
        <ErrorState
          title={t("page.loadError")}
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("page.title")} description={t("page.description")}>
        {back}
        <CancelExportButton item={detail} />
      </PageHeader>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {isLive(detail) ? (
            <ProgressCard detail={detail} />
          ) : (
            <ResultCard detail={detail} now={now} />
          )}
          <FailuresCard detail={detail} />
        </div>
        <RequestCard detail={detail} />
      </div>
    </div>
  );
}

function ProgressCard({ detail }: { detail: MailExportDetail }) {
  const { t, i18n } = useTranslation("exports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const progress = detail.progress;
  const eta = etaMinutes(progress);
  const phase = phaseKey(detail.phase);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("progress.title")}</CardTitle>
          <CardDescription>
            {detail.status === "queued"
              ? t("progress.queued")
              : phase
                ? t(phase)
                : t("progress.running")}
          </CardDescription>
        </div>
        <ExportStatusBadge item={detail} />
      </CardHeader>
      <CardContent className="space-y-3">
        <ProgressBar
          ratio={detail.status === "queued" ? 0 : progressRatio(progress)}
          label={t("progress.label")}
          tone={(progress?.failed ?? 0) > 0 ? "destructive" : "default"}
        />
        {progress && progress.total > 0 ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
            <span>
              {t("progress.count", {
                done: formatInteger(progress.done, language),
                total: formatInteger(progress.total, language),
              })}
            </span>
            {progress.failed > 0 ? (
              <span className="text-destructive">
                {t("progress.failed", { count: progress.failed })}
              </span>
            ) : null}
            <span className="text-muted-foreground">{formatBytes(progress.bytes, language)}</span>
            {eta !== null ? (
              <span className="text-muted-foreground">{t("progress.eta", { minutes: eta })}</span>
            ) : null}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Hourglass className="size-4" aria-hidden="true" />
            {t(detail.status === "queued" ? "progress.waiting" : "progress.counting")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("progress.leaveHint")}</p>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: { label: string; value: string; tone?: "destructive" | "warning" }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          tone === "destructive"
            ? "text-lg font-semibold tabular-nums text-destructive"
            : tone === "warning"
              ? "text-lg font-semibold tabular-nums text-warning-foreground dark:text-warning"
              : "text-lg font-semibold tabular-nums"
        }
      >
        {value}
      </p>
    </div>
  );
}

function ResultCard({ detail, now }: { detail: MailExportDetail; now: number }) {
  const { t, i18n } = useTranslation("exports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const report = detail.report;
  const number = (value: number) => formatInteger(value, language);
  const skipped = skippedEntries(report?.skipped);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("result.title")}</CardTitle>
          <CardDescription>
            {detail.completedAt
              ? t("result.finishedAt", { date: formatDateTime(detail.completedAt, language) })
              : t("result.notFinished")}
          </CardDescription>
        </div>
        <ExportStatusBadge item={detail} />
      </CardHeader>
      <CardContent className="space-y-4">
        {detail.status === "failed" ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t("result.failed")}</AlertTitle>
            <AlertDescription>{detail.errorMessage ?? t("result.failedUnknown")}</AlertDescription>
          </Alert>
        ) : null}
        {detail.status === "cancelled" ? (
          <Alert variant="info">
            <Ban />
            <AlertTitle>{t("result.cancelled")}</AlertTitle>
            <AlertDescription>{t("result.cancelledDescription")}</AlertDescription>
          </Alert>
        ) : null}

        {detail.status === "completed" ? <FileBlock detail={detail} now={now} /> : null}

        {report ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t("result.messages")} value={number(report.messages)} />
            <Stat label={t("result.folders")} value={number(report.folders)} />
            <Stat label={t("result.mailData")} value={formatBytes(report.bytes, language)} />
            <Stat
              label={t("result.failedMessages")}
              value={number(report.failed)}
              tone={report.failed > 0 ? "destructive" : undefined}
            />
          </div>
        ) : detail.status === "completed" ? (
          <p className="text-sm text-muted-foreground">{t("result.noReport")}</p>
        ) : null}

        {skipped.length > 0 ? (
          <div className="rounded-md border border-border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Info className="size-4 text-muted-foreground" aria-hidden="true" />
              {t("skipped.title")}
            </p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-9 text-sm text-muted-foreground">
              {skipped.map((entry) => (
                <li key={entry.kind}>{t(`skipped.${entry.kind}`, { count: entry.count })}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The finished file: name, size, checksum, the download button and how long it stays available. */
function FileBlock({ detail, now }: { detail: MailExportDetail; now: number }) {
  const { t, i18n } = useTranslation("exports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const text = useExportText();
  const state = downloadState(detail, now);
  const expiry = expiryOf(detail.expiresAt, now);
  const message = expiryMessage(expiry);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">
          <FileArchive className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 basis-48 space-y-0.5">
          <p className="break-all font-medium">{detail.fileName ?? t("result.fileNameUnknown")}</p>
          <p className="text-sm text-muted-foreground">
            {[
              text.formatLabel(detail.format),
              detail.fileSize !== null ? formatBytes(detail.fileSize, language) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <DownloadExportButton
          item={detail}
          now={now}
          size="lg"
          showWhenPending
          className="w-full sm:w-auto"
        />
      </div>

      {state === "expired" ? (
        <Alert variant="warning">
          <Clock />
          <AlertTitle>{t("result.expired.title")}</AlertTitle>
          <AlertDescription>
            {t("result.expired.description", {
              date: formatDateTime(detail.expiresAt, language) ?? "",
            })}
          </AlertDescription>
        </Alert>
      ) : message ? (
        <p
          className="flex items-center gap-2 text-sm"
          title={formatDateTime(detail.expiresAt, language) ?? undefined}
        >
          <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
          {t(message.key, message.values)}
        </p>
      ) : null}

      {detail.sha256 ? (
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {t("result.checksum")}
          </p>
          <div className="flex items-start gap-1">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
              {detail.sha256}
            </code>
            <CopyButton value={detail.sha256} label={t("result.copyChecksum")} />
          </div>
          <p className="text-xs text-muted-foreground">{t("result.checksumHint")}</p>
        </div>
      ) : null}
    </div>
  );
}

function FailuresCard({ detail }: { detail: MailExportDetail }) {
  const { t, i18n } = useTranslation("exports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const rows = failureRows(detail);
  if (rows.length === 0) {
    return null;
  }
  const total = detail.report?.failed ?? rows.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("failures.title")}</CardTitle>
        <CardDescription>
          {t(isLive(detail) ? "failures.descriptionLive" : "failures.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => (
            <li key={`${row.ref}:${row.reason}`} className="space-y-0.5 px-3 py-2 text-sm">
              <p className="break-all font-mono text-xs">{row.ref}</p>
              <p className="break-words text-xs text-muted-foreground" lang="en">
                {row.reason}
              </p>
            </li>
          ))}
        </ul>
        {total > rows.length ? (
          <p className="text-xs text-muted-foreground">
            {t("failures.truncated", {
              shown: formatInteger(rows.length, language),
              total: formatInteger(total, language),
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RequestCard({ detail }: { detail: MailExportDetail }) {
  const { t, i18n } = useTranslation("exports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const text = useExportText();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("request.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Facts className="grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)]">
          <Fact label={t("request.source")}>
            <span className="flex min-w-0 items-center gap-2">
              {detail.object ? <ObjectIcon kind={detail.object.kind} /> : null}
              <span className="truncate">{text.source(detail)}</span>
            </span>
          </Fact>
          <Fact label={t("request.selection")}>{text.selection(detail)}</Fact>
          <Fact label={t("request.format")}>{text.formatLabel(detail.format)}</Fact>
          <Fact label={t("request.actor")}>
            {text.actor(detail.actor)}
            {detail.impersonated ? (
              <Badge variant="outline" className="ml-2">
                {t("adminExport")}
              </Badge>
            ) : null}
          </Fact>
          {detail.reason ? <Fact label={t("request.reason")}>{detail.reason}</Fact> : null}
          <Fact label={t("request.requested")}>{formatDateTime(detail.createdAt, language)}</Fact>
          {detail.completedAt ? (
            <Fact label={t("request.finished")}>
              {formatDateTime(detail.completedAt, language)}
            </Fact>
          ) : null}
        </Facts>
      </CardContent>
    </Card>
  );
}
