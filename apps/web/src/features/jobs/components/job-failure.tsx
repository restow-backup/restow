import { useTranslation } from "react-i18next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FailureExplanation } from "@/features/failures";
import type { Job, JobDetail } from "@/features/jobs/api";
import { objectLabel } from "@/features/jobs/presenters";
import type { JobFormat } from "@/features/jobs/use-format";
import { useRetryJob } from "@/features/jobs/use-jobs";

/**
 * Why the job failed, what happened and what to do. A job that is queued again
 * after a failed attempt (or already running its retry) shows the earlier
 * attempt, so the operator sees the trouble before the final verdict. A failed
 * row from before causes were kept still shows its recorded message.
 */
export function JobFailure({
  job,
  format,
  onRetried,
}: {
  job: JobDetail;
  format: JobFormat;
  onRetried: (job: Job) => void;
}) {
  const retry = useRetryJob();
  const failed = job.status === "failed";
  const retrying = job.status === "queued" || job.status === "active";
  if (!failed && !(retrying && job.failure)) {
    return null;
  }
  if (failed && !job.failure && !job.errorMessage) {
    return null;
  }
  return (
    <FailureExplanation
      failure={job.failure ?? null}
      message={job.errorMessage}
      subject={{
        kind: "job",
        queue: format.queue(job.queue),
        object: job.object ? objectLabel(job.object) : null,
      }}
      sourceId={job.object?.sourceId ?? null}
      at={job.completedAt ?? job.updatedAt}
      docsUrl={job.docsUrl ?? null}
      affectedItems={job.progress?.failed ?? 0}
      retrying={retrying}
      // A restore check that could not complete proves nothing about the backup: neutral.
      tone={job.checkIncomplete ? "info" : undefined}
      onRetry={
        failed && job.retryable ? () => retry.mutate(job.id, { onSuccess: onRetried }) : null
      }
      retryPending={retry.isPending}
    />
  );
}

/** The failed items of a finished run, grouped by cause: how many, why, what to do. */
export function FailureGroupsCard({ job }: { job: JobDetail }) {
  const { t } = useTranslation("failures");
  const groups = job.failureGroups ?? [];
  if (groups.length === 0) {
    return null;
  }
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">{t("section.itemsByCause")}</CardTitle>
        <CardDescription>{t("section.itemsByCauseHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.map((group) => (
          <div key={group.failure.code} className="space-y-2" data-cause={group.failure.code}>
            <p className="text-sm font-medium">{t("what.itemGroup", { count: group.count })}</p>
            <FailureExplanation
              failure={group.failure}
              subject={{ kind: "none" }}
              hideWhat
              tone="warning"
              sourceId={job.object?.sourceId ?? null}
              affectedItems={group.count}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
