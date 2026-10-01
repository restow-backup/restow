import { Link } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  JOB_QUEUES,
  JOB_STATUSES,
  type Job,
  type JobFilters,
  type JobQueue,
  type JobStatus,
} from "@/features/jobs/api";
import { BackupAllButton, JobActions } from "@/features/jobs/components/actions";
import { JobCause } from "@/features/jobs/components/job-cause";
import { ProgressBar, ProgressSummary } from "@/features/jobs/components/job-progress";
import { JobStatusBadge, LiveIndicator, ObjectKindIcon } from "@/features/jobs/components/status";
import { jobDetailTo } from "@/features/jobs/paths";
import { isLive, jobDurationSeconds, jobTriggerKey, objectLabel } from "@/features/jobs/presenters";
import { type JobFormat, useJobFormat } from "@/features/jobs/use-format";
import { useLiveJobs, useNow } from "@/features/jobs/use-jobs";

const ALL = "all";
const NO_FILTERS: JobFilters = { queue: null, status: null };

/** Every job of the tenant, newest first, with live progress. */
export function JobsPage() {
  const { t } = useTranslation("backup");
  const format = useJobFormat();
  const [filters, setFilters] = React.useState<JobFilters>(NO_FILTERS);
  const { list, jobs, stream } = useLiveJobs(filters);
  const now = useNow(jobs.some((job) => isLive(job.status)));
  const filtered = filters.queue !== null || filters.status !== null;

  return (
    <div className="space-y-6">
      <PageHeader title={t("jobs.title")} description={t("jobs.description")}>
        <LiveIndicator status={stream} />
        <BackupAllButton />
      </PageHeader>

      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          id="jobs-filter-queue"
          label={t("jobs.filterQueue")}
          allLabel={t("jobs.allQueues")}
          value={filters.queue}
          options={JOB_QUEUES.map((queue) => ({ value: queue, label: format.queue(queue) }))}
          onChange={(queue) =>
            setFilters((current) => ({ ...current, queue: queue as JobQueue | null }))
          }
        />
        <FilterSelect
          id="jobs-filter-status"
          label={t("jobs.filterStatus")}
          allLabel={t("jobs.allStatuses")}
          value={filters.status}
          options={JOB_STATUSES.map((status) => ({ value: status, label: format.status(status) }))}
          onChange={(status) =>
            setFilters((current) => ({ ...current, status: status as JobStatus | null }))
          }
        />
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
            {t("actions.clearFilters")}
          </Button>
        ) : null}
      </div>

      {list.isPending ? (
        <Card>
          <CardContent className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </CardContent>
        </Card>
      ) : list.isError ? (
        <ErrorState
          title={t("jobs.loadError")}
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : jobs.length === 0 ? (
        <Card className="py-0">
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <ListChecks className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="max-w-md text-sm text-muted-foreground">
              {filtered ? t("jobs.emptyFiltered") : t("jobs.empty")}
            </p>
            {filtered ? (
              <Button variant="outline" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                {t("actions.clearFilters")}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t("jobs.columns.job")}</TableHead>
                <TableHead>{t("jobs.columns.object")}</TableHead>
                <TableHead>{t("jobs.columns.status")}</TableHead>
                <TableHead className="min-w-56">{t("jobs.columns.progress")}</TableHead>
                <TableHead>{t("jobs.columns.started")}</TableHead>
                <TableHead>{t("jobs.columns.duration")}</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">{t("jobs.columns.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} now={now} format={format} />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {list.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void list.fetchNextPage()}
            loading={list.isFetchingNextPage}
          >
            {t("actions.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function JobRow({ job, now, format }: { job: Job; now: number; format: JobFormat }) {
  const { t } = format;
  const duration = jobDurationSeconds(job, now);
  return (
    <TableRow>
      <TableCell className="pl-4 align-top">
        <Link
          to={jobDetailTo(job.id)}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {format.queue(job.queue)}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>{t(jobTriggerKey(job))}</span>
          {job.full ? <Badge variant="outline">{t("jobs.full")}</Badge> : null}
        </div>
      </TableCell>
      <TableCell className="max-w-64 align-top">
        {job.object ? (
          <div className="flex min-w-0 items-start gap-2">
            <ObjectKindIcon kind={job.object.kind} className="mt-0.5 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate">{objectLabel(job.object)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {format.kind(job.object.kind)}
              </p>
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground">{t("jobs.tenantWide")}</span>
        )}
      </TableCell>
      <TableCell className="max-w-64 align-top">
        <div className="space-y-1">
          <JobStatusBadge
            status={job.status}
            failedItems={job.progress?.failed}
            queue={job.queue}
            checkIncomplete={job.checkIncomplete}
          />
          <JobCause job={job} />
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="space-y-1.5">
          <ProgressBar job={job} />
          {job.status === "active" && job.phase ? (
            <p className="text-xs font-medium">{format.phase(job.phase.name)}</p>
          ) : null}
          <ProgressSummary job={job} now={now} />
        </div>
      </TableCell>
      <TableCell
        className="align-top text-muted-foreground"
        title={format.dateTime(job.startedAt ?? job.createdAt) ?? undefined}
      >
        {job.startedAt ? format.relative(job.startedAt) : t("progress.notStarted")}
      </TableCell>
      <TableCell className="align-top tabular-nums text-muted-foreground">
        {duration === null ? "–" : format.duration(duration)}
      </TableCell>
      <TableCell className="pr-4 align-top">
        <JobActions job={job} />
      </TableCell>
    </TableRow>
  );
}

function FilterSelect({
  id,
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  allLabel: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
        <SelectTrigger id={id} className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
