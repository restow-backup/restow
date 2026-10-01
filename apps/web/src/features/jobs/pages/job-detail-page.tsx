import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Ban, ShieldAlert } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CauseLine, FailureExplanation } from "@/features/failures";
import type { BackupResult, Job, JobDetail } from "@/features/jobs/api";
import { JobActions } from "@/features/jobs/components/actions";
import { FailureGroupsCard, JobFailure } from "@/features/jobs/components/job-failure";
import {
  ProgressBar,
  ProgressSummary,
  ThrottleNotice,
} from "@/features/jobs/components/job-progress";
import {
  JobStatusBadge,
  LiveIndicator,
  ObjectKindIcon,
  SnapshotStateBadge,
} from "@/features/jobs/components/status";
import { historyTo, jobDetailTo } from "@/features/jobs/paths";
import { isLive, jobDurationSeconds, jobTriggerKey, objectLabel } from "@/features/jobs/presenters";
import { type JobFormat, useJobFormat } from "@/features/jobs/use-format";
import { useLiveJob, useNow, useRetryJob } from "@/features/jobs/use-jobs";
import { ApiError } from "@/lib/api";

/** One job: live progress, Microsoft pauses, the outcome and every failed item. */
export function JobDetailPage({ jobId }: { jobId: string }) {
  const { t } = useTranslation("backup");
  const format = useJobFormat();
  const navigate = useNavigate();
  const { detail, stream } = useLiveJob(jobId);
  const job = detail.data;
  const now = useNow(job !== undefined && isLive(job.status));

  const back = (
    <Link
      to={historyTo()}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t("actions.backToJobs")}
    </Link>
  );

  if (detail.isPending) {
    return (
      <div className="space-y-6">
        {back}
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (detail.isError || !job) {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="space-y-6">
        {back}
        {missing ? (
          <Alert variant="warning">
            <ShieldAlert />
            <AlertTitle>{t("detail.loadError")}</AlertTitle>
            <AlertDescription>{t("detail.notFound")}</AlertDescription>
          </Alert>
        ) : (
          <ErrorState
            title={t("detail.loadError")}
            error={detail.error}
            onRetry={() => void detail.refetch()}
            retrying={detail.isFetching}
          />
        )}
      </div>
    );
  }

  const duration = jobDurationSeconds(job, now);

  return (
    <div className="space-y-6">
      {back}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("detail.title", { queue: format.queue(job.queue) })}
            </h1>
            <JobStatusBadge
              status={job.status}
              failedItems={job.progress?.failed}
              queue={job.queue}
              checkIncomplete={job.checkIncomplete}
            />
            <LiveIndicator status={stream} />
          </div>
          {job.object ? (
            <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <ObjectKindIcon kind={job.object.kind} />
              <span className="truncate">{objectLabel(job.object)}</span>
              {job.object.displayName && job.object.displayName !== job.object.externalId ? (
                <span className="truncate">({job.object.externalId})</span>
              ) : null}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("jobs.tenantWide")}</p>
          )}
        </div>
        <JobActions
          job={job}
          size="default"
          onRetried={(next) => void navigate({ to: jobDetailTo(next.id) })}
        />
      </div>

      <JobFailure
        job={job}
        format={format}
        onRetried={(next) => void navigate({ to: jobDetailTo(next.id) })}
      />
      {job.status === "cancelled" ? (
        <Alert variant="info">
          <Ban />
          <AlertDescription>{t("detail.cancelledInfo")}</AlertDescription>
        </Alert>
      ) : null}

      <ThrottleNotice job={job} now={now} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="gap-3 lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{t("progress.label")}</CardTitle>
            {job.status === "active" && job.phase ? (
              <CardDescription>
                {t("detail.phase", { phase: format.phase(job.phase.name) })}
                {job.phase.since
                  ? ` · ${t("detail.since", { time: format.relative(job.phase.since) ?? "" })}`
                  : null}
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            <ProgressBar job={job} className="h-2" />
            <ProgressSummary job={job} now={now} />
            {job.result ? <ResultSummary result={job.result} format={format} /> : null}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <Fact label={t("detail.created")}>{format.dateTime(job.createdAt) ?? "–"}</Fact>
              <Fact label={t("detail.started")}>
                {format.dateTime(job.startedAt) ?? t("progress.notStarted")}
              </Fact>
              <Fact label={t("detail.finished")}>{format.dateTime(job.completedAt) ?? "–"}</Fact>
              <Fact label={t("detail.duration")}>
                {duration === null ? "–" : format.duration(duration)}
              </Fact>
              <Fact label={t("detail.trigger")}>{t(jobTriggerKey(job))}</Fact>
              {job.queue === "backup" ? (
                <Fact label={t("detail.mode")}>
                  {job.full ? t("detail.modeFull") : t("detail.modeIncremental")}
                </Fact>
              ) : null}
              {job.queue === "backup" ? (
                <Fact label={t("detail.snapshotState")}>
                  {job.snapshot ? (
                    <span className="inline-flex items-center gap-2">
                      {t("detail.resultSnapshot", {
                        sequence: format.integer(job.snapshot.sequence),
                      })}
                      <SnapshotStateBadge state={job.snapshot.state} />
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("detail.noSnapshot")}</span>
                  )}
                </Fact>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </div>

      <FailureGroupsCard job={job} />
      <FailuresCard job={job} format={format} />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </>
  );
}

function ResultSummary({ result, format }: { result: BackupResult; format: JobFormat }) {
  const { t } = format;
  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
      <p className="font-medium">{t("detail.result")}</p>
      <p>
        {t("detail.resultItems", {
          total: format.integer(result.objectsTotal),
          written: format.integer(result.objectsWritten),
        })}
      </p>
      <p>{t("detail.resultBytes", { bytes: format.bytes(result.bytes) })}</p>
      {result.throttleWaits > 0 ? (
        <p className="text-muted-foreground">
          {t("throttle.summary", {
            count: result.throttleWaits,
            duration: format.duration(result.throttleWaitMs / 1000),
          })}
        </p>
      ) : null}
      {result.repairedCopies > 0 ? (
        <p className="text-muted-foreground">
          {t("detail.resultCopies", { count: result.repairedCopies })}
        </p>
      ) : null}
      {result.verifyJobId ? (
        <p>
          <Link
            to={jobDetailTo(result.verifyJobId)}
            className="text-primary underline-offset-4 hover:underline"
          >
            {t("detail.resultVerify")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function FailuresCard({ job, format }: { job: JobDetail; format: JobFormat }) {
  const { t } = format;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">{t("failures.title")}</CardTitle>
        <CardDescription>{t("failures.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {job.failures.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("failures.empty")}</p>
        ) : (
          <div className="space-y-3">
            {job.failureCount > job.failures.length ? (
              <p className="text-xs text-muted-foreground">
                {t("failures.capped", {
                  shown: format.integer(job.failures.length),
                  total: format.integer(job.failureCount),
                })}
              </p>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("failures.item")}</TableHead>
                  <TableHead>{t("failures.reason")}</TableHead>
                  <TableHead className="text-right">{t("failures.attempts")}</TableHead>
                  <TableHead className="text-right">{t("failures.lastAttempt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {job.failures.map((failure) => (
                  <TableRow key={failure.id}>
                    <TableCell className="max-w-72 break-all font-mono text-xs">
                      {failure.itemRef}
                    </TableCell>
                    <TableCell className="max-w-96 break-words text-sm">
                      {failure.failure ? (
                        <div className="space-y-0.5">
                          <CauseLine
                            failure={failure.failure}
                            className="text-sm text-foreground"
                          />
                          <p className="text-xs text-muted-foreground">{failure.reason}</p>
                        </div>
                      ) : (
                        failure.reason
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {failure.attempts >= 3 ? (
                        <Badge variant="destructive">
                          {t("failures.repeated", { count: failure.attempts })}
                        </Badge>
                      ) : (
                        <span className="tabular-nums">{format.integer(failure.attempts)}</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-right text-muted-foreground"
                      title={format.dateTime(failure.lastAttemptAt) ?? undefined}
                    >
                      {format.relative(failure.lastAttemptAt) ?? "–"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
