import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJob, jobKeys } from "@/features/jobs/api";
import { FailuresCard } from "@/features/jobs/components/failures-card";
import { FailureGroupsCard } from "@/features/jobs/components/job-failure";
import { ThrottleNotice } from "@/features/jobs/components/job-progress";
import { HISTORY_PATH, jobDetailTo } from "@/features/jobs/paths";
import { useJobFormat } from "@/features/jobs/use-format";
import { ApiError } from "@/lib/api";

import { RunActions } from "../components/run-actions";
import { RunStateBadge, SubjectIcon, useRunTitle } from "../components/run-parts";
import { RunView } from "../components/run-view";
import { mergeRun, useHistoryScope, useRunDetail } from "../hooks";
import { useSecondClock } from "../live/clock";
import { useLiveRun } from "../live/provider";

/**
 * The page of one run (`/history/<id>`, also where an old `/jobs/<id>` leads): what the drawer
 * shows, with room for what only a page has. For a mail run that is the failed items grouped by
 * cause and listed one by one, and the explanation of a Microsoft pause; for an agent run the
 * link to the machine. It is live like the drawer: the numbers move with the channel.
 */
export function RunDetailPage({ runId }: { runId: string }) {
  const { t } = useTranslation("history");
  const title = useRunTitle();
  const navigate = useNavigate();
  const detail = useRunDetail(runId);
  const live = useLiveRun(runId);
  const run = mergeRun(detail.data, live);
  const mail = run?.source === "mail";
  const now = useSecondClock(run?.state === "running");

  // The failed items come from the job endpoint of the mail run, which has always had them.
  const { tenantId, enabled } = useHistoryScope();
  const format = useJobFormat();
  const items = useQuery({
    queryKey: jobKeys.detail(tenantId, runId),
    queryFn: () => fetchJob(runId),
    enabled: enabled && mail === true,
    retry: false,
  });

  const back = (
    <Link
      to={HISTORY_PATH as never}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {t("detail.back")}
    </Link>
  );

  if (!run) {
    if (detail.isPending) {
      return (
        <div className="space-y-6" aria-busy="true">
          {back}
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      );
    }
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

  return (
    <div className="space-y-6" data-slot="run-detail-page">
      {back}
      <PageHeader
        icon={null}
        title={title(run)}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {run.subject ? (
              <SubjectIcon kind={run.subject.kind} className="text-muted-foreground" />
            ) : null}
            <RunStateBadge run={run} />
            {run.attempt ? (
              <span>{t("attempt", { number: run.attempt.number, of: run.attempt.of })}</span>
            ) : null}
            {run.job ? <span>{run.job.name}</span> : null}
          </span>
        }
        actions={
          <RunActions run={run} where="page" className="flex flex-wrap items-center gap-2" />
        }
      />
      {mail && run.state === "running" ? (
        <ThrottleNotice job={{ status: "active", throttle: run.throttle }} now={now} />
      ) : null}
      <RunView
        run={run}
        detail={detail.data}
        loading={detail.isPending}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        onOpenRun={(id) => void navigate({ to: jobDetailTo(id) })}
        // A mail run lists its failed items in full below (the cards); a machine run has only these.
        itemsOnPage={mail}
      />
      {mail && items.data ? (
        <>
          <FailureGroupsCard job={items.data} />
          <FailuresCard job={items.data} format={format} />
        </>
      ) : null}
    </div>
  );
}
