import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Ban, Clock, Hourglass, Info } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FailureExplanation } from "@/features/failures";
import { ThrottleNotice } from "@/features/jobs/components/job-progress";
import { isWaitingForThrottle } from "@/features/jobs/presenters";
import { useJobFormat } from "@/features/jobs/use-format";
import { useNow } from "@/features/jobs/use-jobs";
import type { RestoreItem, RestoreJobDetail } from "@/features/restore/api";
import { Fact, Facts } from "@/features/restore/components/facts";
import { JobStatusBadge } from "@/features/restore/components/job-status-badge";
import { ProgressBar } from "@/features/restore/components/progress-bar";
import { EntryIcon, ObjectIcon } from "@/features/restore/explorer/entry-icon";
import {
  CancelRestoreButton,
  DownloadArchiveLink,
  RequestAgainLink,
} from "@/features/restore/jobs/job-actions";
import { useJobText } from "@/features/restore/jobs/use-job-text";
import { displayName } from "@/features/restore/lib/entries";
import {
  type ItemFilter,
  countByFilter,
  etaMinutes,
  initialFilter,
  isLive,
  itemKind,
  matchesFilter,
  progressRatio,
} from "@/features/restore/lib/jobs";
import { RECENT_RESTORES_SEARCH, RESTORE_PATHS, restoreTo } from "@/features/restore/navigation";
import { useRestoreJob } from "@/features/restore/use-restore-data";
import { formatBytes, formatDateTime, formatInteger } from "@/lib/format";

/**
 * One restore from request to result: live progress while it runs, then what
 * was restored, skipped, failed or could not be confirmed, item by item.
 */
export function RestoreJobPage({ restoreId }: { restoreId: string }) {
  const { t } = useTranslation("restore");
  const job = useRestoreJob(restoreId);

  const back = (
    <Link
      to={restoreTo(RESTORE_PATHS.explorer)}
      search={RECENT_RESTORES_SEARCH as never}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      <ArrowLeft />
      {t("job.back")}
    </Link>
  );

  if (job.isPending) {
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
  if (job.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("job.title")}>{back}</PageHeader>
        <ErrorState
          title={t("job.loadError")}
          error={job.error}
          onRetry={() => void job.refetch()}
          retrying={job.isFetching}
        />
      </div>
    );
  }

  const detail = job.data;
  return (
    <div className="space-y-6">
      <PageHeader title={t("job.title")} description={t("job.subtitle")}>
        {back}
        <CancelRestoreButton job={detail} />
        <DownloadArchiveLink job={detail} />
      </PageHeader>

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {isLive(detail) ? <ProgressCard job={detail} /> : <OutcomeCard job={detail} />}
          <ItemsCard job={detail} />
        </div>
        <RequestCard job={detail} />
      </div>
    </div>
  );
}

function ProgressCard({ job }: { job: RestoreJobDetail }) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const progress = job.progress;
  // The clock only ticks while there is a Microsoft pause to count down.
  const now = useNow(job.status === "active" && job.throttle !== null);
  // While Microsoft holds the restore back, a time estimate would be a guess.
  const eta = isWaitingForThrottle(job, now) ? null : etaMinutes(progress);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("job.progress.title")}</CardTitle>
          <CardDescription>
            {job.status === "queued" ? t("job.progress.queued") : t("job.progress.running")}
          </CardDescription>
        </div>
        <JobStatusBadge job={job} />
      </CardHeader>
      <CardContent className="space-y-3">
        <ProgressBar
          ratio={job.status === "queued" ? 0 : progressRatio(progress)}
          label={t("jobs.progressLabel")}
          tone={(progress?.failed ?? 0) > 0 ? "destructive" : "default"}
        />
        {progress && progress.total > 0 ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums">
            <span>
              {t("jobs.progress", {
                done: formatInteger(progress.done, language),
                total: formatInteger(progress.total, language),
              })}
            </span>
            {progress.failed > 0 ? (
              <span className="text-destructive">
                {t("job.progress.failed", { count: progress.failed })}
              </span>
            ) : null}
            <span className="text-muted-foreground">{formatBytes(progress.bytes, language)}</span>
            {eta !== null ? (
              <span className="text-muted-foreground">
                {t("job.progress.eta", { minutes: eta })}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Hourglass className="size-4" aria-hidden="true" />
            {t(job.status === "queued" ? "job.progress.waiting" : "job.progress.counting")}
          </p>
        )}
        <ThrottleNotice job={job} now={now} />
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

function OutcomeCard({ job }: { job: RestoreJobDetail }) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const jobFormat = useJobFormat();
  const result = job.result;
  const number = (value: number) => formatInteger(value, language);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("job.outcome.title")}</CardTitle>
          <CardDescription>
            {job.completedAt
              ? t("job.outcome.finishedAt", { date: formatDateTime(job.completedAt, language) })
              : t("job.outcome.notFinished")}
          </CardDescription>
        </div>
        <JobStatusBadge job={job} />
      </CardHeader>
      <CardContent className="space-y-4">
        {job.status === "failed" ? (
          job.failure || job.errorMessage ? (
            <div className="space-y-2">
              <p className="font-medium text-destructive">{t("job.outcome.failed")}</p>
              {/* The cause in the reader's language; the engine's own text sits under "Technical details". */}
              <FailureExplanation
                failure={job.failure ?? null}
                message={job.errorMessage}
                subject={{ kind: "none" }}
                hideWhat
                at={job.completedAt}
              />
            </div>
          ) : (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>{t("job.outcome.failed")}</AlertTitle>
              <AlertDescription>{t("job.outcome.failedUnknown")}</AlertDescription>
            </Alert>
          )
        ) : null}
        {job.status === "cancelled" ? (
          <Alert variant="info">
            <Ban />
            <AlertTitle>{t("job.outcome.cancelled")}</AlertTitle>
            <AlertDescription>
              {job.target.type === "download" ? (
                <>
                  <p>{t("job.outcome.cancelledDescriptionDownload")}</p>
                  <div className="mt-2">
                    <RequestAgainLink job={job} />
                  </div>
                </>
              ) : (
                t("job.outcome.cancelledDescription")
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {result ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label={t("job.outcome.restored")} value={number(result.restored)} />
            <Stat label={t("job.outcome.skipped")} value={number(result.skipped)} />
            <Stat
              label={t("job.outcome.failures")}
              value={number(result.failures)}
              tone={result.failures > 0 ? "destructive" : undefined}
            />
            {result.unverified > 0 ? (
              <Stat
                label={t("job.outcome.unverified")}
                value={number(result.unverified)}
                tone="warning"
              />
            ) : null}
            {result.folders > 0 ? (
              <Stat label={t("job.outcome.folders")} value={number(result.folders)} />
            ) : null}
            <Stat label={t("job.outcome.bytes")} value={formatBytes(result.bytes, language)} />
          </div>
        ) : job.status === "completed" ? (
          <p className="text-sm text-muted-foreground">{t("job.outcome.noResult")}</p>
        ) : null}

        {result && result.throttleWaits > 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Hourglass className="size-4" aria-hidden="true" />
            {jobFormat.t("throttle.summary", {
              count: result.throttleWaits,
              duration: jobFormat.duration(result.throttleWaitMs / 1000),
            })}
          </p>
        ) : null}

        {job.target.type === "download" && job.status === "completed" ? (
          job.download.available ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="size-4" aria-hidden="true" />
              {t("jobs.download.until", {
                date: formatDateTime(job.download.expiresAt, language) ?? "",
              })}
            </p>
          ) : (
            <Alert variant="warning">
              <Clock />
              <AlertTitle>{t("job.outcome.downloadExpired")}</AlertTitle>
              <AlertDescription>
                <p>
                  {t("job.outcome.downloadExpiredDescription", {
                    date: formatDateTime(job.download.expiresAt, language) ?? "",
                  })}
                </p>
                <div className="mt-2">
                  <RequestAgainLink job={job} />
                </div>
              </AlertDescription>
            </Alert>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function RequestCard({ job }: { job: RestoreJobDetail }) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const text = useJobText();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("job.request.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Facts className="grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)]">
          <Fact label={t("job.request.object")}>
            <span className="flex min-w-0 items-center gap-2">
              {job.object ? <ObjectIcon kind={job.object.kind} /> : null}
              <span className="truncate">{text.object(job)}</span>
            </span>
          </Fact>
          <Fact label={t("job.request.snapshot")}>
            {job.snapshotSequence !== null
              ? t("jobs.snapshot", {
                  sequence: job.snapshotSequence,
                  date: formatDateTime(job.snapshotAt, language) ?? "",
                })
              : t("job.request.snapshotPruned")}
          </Fact>
          <Fact label={t("job.request.selection")}>{text.selection(job.selection)}</Fact>
          <Fact label={t("job.request.target")}>{text.target(job.target)}</Fact>
          {job.target.type === "download" ? null : (
            <Fact label={t("job.request.mode")}>{text.mode(job.mode)}</Fact>
          )}
          <Fact label={t("job.request.actor")}>
            {text.actor(job.actor)}
            {job.impersonated ? (
              <Badge variant="outline" className="ml-2">
                {t("jobs.adminRestore")}
              </Badge>
            ) : null}
          </Fact>
          {job.reason ? <Fact label={t("job.request.reason")}>{job.reason}</Fact> : null}
          <Fact label={t("job.request.requested")}>{formatDateTime(job.createdAt, language)}</Fact>
          {job.startedAt ? (
            <Fact label={t("job.request.started")}>{formatDateTime(job.startedAt, language)}</Fact>
          ) : null}
          {job.completedAt ? (
            <Fact label={t("job.request.finished")}>
              {formatDateTime(job.completedAt, language)}
            </Fact>
          ) : null}
        </Facts>
      </CardContent>
    </Card>
  );
}

const FILTERS: readonly ItemFilter[] = [
  "attention",
  "failed",
  "skipped",
  "unverified",
  "restored",
  "all",
];

const STATUS_VARIANT: Record<RestoreItem["status"], BadgeProps["variant"]> = {
  restored: "success",
  skipped: "secondary",
  failed: "destructive",
};

function ItemsCard({ job }: { job: RestoreJobDetail }) {
  const { t } = useTranslation("restore");
  const items = job.items;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("items.title")}</CardTitle>
        <CardDescription>{t("items.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {items ? (
          <ItemResults items={items.items} total={items.total} truncated={items.truncated} />
        ) : job.failures.length > 0 ? (
          <LiveFailures job={job} />
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Info className="size-4" aria-hidden="true" />
            {t(isLive(job) ? "items.pending" : "items.none")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ItemResults({
  items,
  total,
  truncated,
}: {
  items: RestoreItem[];
  total: number;
  truncated: boolean;
}) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const counts = countByFilter(items);
  const [filter, setFilter] = React.useState<ItemFilter>(() => initialFilter(items));
  const visible = items.filter((item) => matchesFilter(item, filter));
  const filters = FILTERS.filter((candidate) => candidate === "all" || counts[candidate] > 0);

  return (
    <div className="space-y-3">
      <Tabs value={filter} onValueChange={(value) => setFilter(value as ItemFilter)}>
        <TabsList className="flex-wrap justify-start group-data-[orientation=horizontal]/tabs:h-auto">
          {filters.map((candidate) => (
            <TabsTrigger key={candidate} value={candidate}>
              {t(`items.filters.${candidate}`)}
              <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                {formatInteger(counts[candidate], language)}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("items.emptyFilter")}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t("items.columns.item")}</TableHead>
              <TableHead>{t("items.columns.outcome")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((item) => {
              const kind = itemKind(item.type);
              return (
                <TableRow key={`${item.status}:${item.path}`}>
                  <TableCell className="max-w-0 w-1/2">
                    <div className="flex min-w-0 items-center gap-2">
                      <EntryIcon kind={kind} />
                      <span className="truncate font-medium">
                        {item.subject ?? displayName({ kind, path: item.path })}
                      </span>
                    </div>
                    {item.from ? (
                      <p className="truncate text-xs text-muted-foreground">{item.from}</p>
                    ) : null}
                    <p className="truncate font-mono text-xs text-muted-foreground">{item.path}</p>
                  </TableCell>
                  <TableCell className="w-1/2 max-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={STATUS_VARIANT[item.status]}>
                        {t(`items.status.${item.status}`)}
                      </Badge>
                      {item.code === "unverified" ? (
                        <Badge variant="warning">{t("items.unverified")}</Badge>
                      ) : null}
                    </div>
                    <ItemExplanation item={item} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {truncated ? (
        <p className="text-xs text-muted-foreground">
          {t("items.truncated", {
            shown: formatInteger(items.length, language),
            total: formatInteger(total, language),
          })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Why an item ended up as it did: the outcome code in the user's language,
 * plus the engine's own detail when there is more to say.
 */
function ItemExplanation({ item }: { item: RestoreItem }) {
  const { t } = useTranslation("restore");
  const explained = item.code && item.code !== "restored" ? t(`items.codes.${item.code}`) : null;
  const detail = item.reason && item.status !== "restored" ? item.reason : null;
  const target = item.status === "restored" ? item.targetRef : null;
  if (!explained && !detail && !target) {
    return null;
  }
  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {explained ? <p>{explained}</p> : null}
      {target ? (
        <p className="truncate" title={target}>
          {t("items.restoredAs", { target })}
        </p>
      ) : null}
      {detail && detail !== explained ? (
        <p className="break-words" lang="en">
          {detail}
        </p>
      ) : null}
    </div>
  );
}

/** While a restore runs, the items it already could not restore. */
function LiveFailures({ job }: { job: RestoreJobDetail }) {
  const { t } = useTranslation("restore");
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {t(isLive(job) ? "items.liveFailures" : "items.failuresOnly")}
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {job.failures.map((failure) => (
          <li key={failure.itemRef} className="space-y-0.5 px-3 py-2 text-sm">
            <p className="truncate font-mono text-xs">{failure.itemRef}</p>
            <p className="break-words text-xs text-muted-foreground" lang="en">
              {failure.reason}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
