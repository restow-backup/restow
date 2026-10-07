import { Link } from "@tanstack/react-router";
import { ArchiveRestore, ChevronRight, RefreshCw, Server } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
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
import { FILE_RESTORE_PATH } from "@/features/endpoints/paths";
import { ThrottleWaitLine } from "@/features/jobs/components/job-progress";
import { useNow } from "@/features/jobs/use-jobs";
import type { RestoreJob } from "@/features/restore/api";
import { EmptyState } from "@/features/restore/components/empty-state";
import { JobStatusBadge } from "@/features/restore/components/job-status-badge";
import { ProgressBar } from "@/features/restore/components/progress-bar";
import { ObjectIcon } from "@/features/restore/explorer/entry-icon";
import { CancelRestoreButton, DownloadArchiveLink } from "@/features/restore/jobs/job-actions";
import { useJobText } from "@/features/restore/jobs/use-job-text";
import { isLive, progressRatio } from "@/features/restore/lib/jobs";
import { RESTORE_PATHS, jobHref, restoreTo, useOpenJob } from "@/features/restore/navigation";
import { RestoreTabs } from "@/features/restore/restore-tabs";
import { useRestoreJobs } from "@/features/restore/use-restore-data";
import { formatDateTime, formatInteger, formatRelative } from "@/lib/format";

/**
 * Every restore and download request the viewer may see, newest first, with
 * live progress while they run and their outcome once they are done.
 */
export function RestoreJobsPage() {
  const { t } = useTranslation("restore");
  const { t: tCommon } = useTranslation();
  const [pages, setPages] = React.useState(1);
  const jobs = useRestoreJobs(pages);

  return (
    <div className="space-y-6">
      <RestoreTabs current="recent" />
      <PageHeader title={t("jobs.title")} description={t("jobs.subtitle")} icon={ArchiveRestore}>
        <Link
          to={FILE_RESTORE_PATH as never}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <Server />
          {t("jobs.machineRestores")}
        </Link>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void jobs.refetch()}
          disabled={jobs.isFetching}
        >
          <RefreshCw className={jobs.isFetching ? "animate-spin" : undefined} />
          {tCommon("actions.refresh")}
        </Button>
        <Link to={restoreTo(RESTORE_PATHS.explorer)} className={buttonVariants({ size: "sm" })}>
          <ArchiveRestore />
          {t("jobs.newRestore")}
        </Link>
      </PageHeader>

      {jobs.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : jobs.isError ? (
        <ErrorState
          title={t("jobs.loadError")}
          error={jobs.error}
          onRetry={() => void jobs.refetch()}
          retrying={jobs.isFetching}
        />
      ) : jobs.data.items.length === 0 ? (
        <EmptyState
          icon={ArchiveRestore}
          title={t("jobs.empty")}
          description={t("jobs.emptyDescription")}
        >
          <Link to={restoreTo(RESTORE_PATHS.explorer)} className={buttonVariants({ size: "sm" })}>
            <ArchiveRestore />
            {t("jobs.newRestore")}
          </Link>
        </EmptyState>
      ) : (
        <Card className="gap-0 py-0">
          <JobsTable jobs={jobs.data.items} />
          <OlderEntries
            shownLabel={t("jobs.shown", { count: jobs.data.items.length })}
            moreLabel={t("jobs.showOlder")}
            hasMore={jobs.data.hasMore}
            loading={jobs.isFetching && jobs.isPlaceholderData}
            onMore={() => setPages((current) => current + 1)}
          />
        </Card>
      )}
    </div>
  );
}

function JobsTable({ jobs }: { jobs: RestoreJob[] }) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const text = useJobText();
  const openJob = useOpenJob();
  // The clock only ticks while a restore has a Microsoft pause to count down.
  const now = useNow(jobs.some((job) => job.status === "active" && job.throttle !== null));

  return (
    <Table className="min-w-[52rem]" scrollLabel={t("jobs.title")}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead pin={PIN_FIRST}>{t("jobs.columns.requested")}</TableHead>
          <TableHead>{t("jobs.columns.object")}</TableHead>
          <TableHead className="hidden lg:table-cell">{t("jobs.columns.what")}</TableHead>
          <TableHead>{t("jobs.columns.status")}</TableHead>
          <TableHead className="text-right">
            <span className="sr-only">{t("jobs.columns.actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => {
          const ratio = progressRatio(job.progress);
          return (
            <TableRow key={job.id} className="cursor-pointer" onClick={() => openJob(job.id)}>
              <TableCell pin={PIN_FIRST} className="whitespace-nowrap">
                <Link
                  to={jobHref(job.id)}
                  onClick={(event) => event.stopPropagation()}
                  className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={formatDateTime(job.createdAt, language) ?? undefined}
                >
                  {formatRelative(job.createdAt, language)}
                </Link>
                <p className="text-xs text-muted-foreground">{text.actor(job.actor)}</p>
              </TableCell>
              <TableCell className="w-[30%] max-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  {job.object ? <ObjectIcon kind={job.object.kind} /> : null}
                  <span className="truncate">{text.object(job)}</span>
                  {job.impersonated ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("jobs.adminRestore")}
                    </Badge>
                  ) : null}
                </div>
                {job.snapshotSequence !== null ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {t("jobs.snapshot", {
                      sequence: job.snapshotSequence,
                      date: formatDateTime(job.snapshotAt, language) ?? "",
                    })}
                  </p>
                ) : null}
              </TableCell>
              <TableCell className="hidden w-[25%] max-w-0 lg:table-cell">
                <p className="truncate">{text.selection(job.selection)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {text.target(job.target)}
                  {job.target.type === "download" ? null : ` · ${text.mode(job.mode)}`}
                </p>
              </TableCell>
              <TableCell className="min-w-40">
                <div className="space-y-1.5">
                  <JobStatusBadge job={job} />
                  {isLive(job) ? (
                    <>
                      <ProgressBar
                        ratio={job.status === "queued" ? 0 : ratio}
                        label={t("jobs.progressLabel")}
                        tone={(job.progress?.failed ?? 0) > 0 ? "destructive" : "default"}
                      />
                      {job.progress && job.progress.total > 0 ? (
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {t("jobs.progress", {
                            done: formatInteger(job.progress.done, language),
                            total: formatInteger(job.progress.total, language),
                          })}
                        </p>
                      ) : null}
                      <ThrottleWaitLine run={job} now={now} className="text-xs" />
                    </>
                  ) : job.result ? (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {t("jobs.outcome", {
                        restored: formatInteger(job.result.restored, language),
                        skipped: formatInteger(job.result.skipped, language),
                        failed: formatInteger(job.result.failures, language),
                      })}
                    </p>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right">
                <div className="flex items-center justify-end gap-2">
                  <DownloadArchiveLink job={job} />
                  <CancelRestoreButton job={job} />
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
