import { useTranslation } from "react-i18next";

import { CauseLine, ItemCauseLines } from "@/features/failures";
import type { Job } from "@/features/jobs/api";
import { cn } from "@/lib/utils";

/**
 * The reason a job failed in one short place, for lists and tables: the cause
 * of a failed (or retrying) run, the causes behind the failed items of a
 * finished run, and for a failed row from before causes were kept its
 * recorded message, cut to one line. Renders nothing for a job that did well.
 */
export function JobCause({
  job,
  className,
}: {
  job: Pick<Job, "status" | "failure" | "itemCauses" | "errorMessage">;
  className?: string;
}) {
  const { t } = useTranslation("failures");
  if (job.failure && (job.status === "failed" || job.status === "queued")) {
    return (
      <div className={cn("space-y-0.5", className)}>
        <CauseLine failure={job.failure} />
        {job.failure.retry && job.status === "queued" ? (
          <p className="text-xs text-muted-foreground">{t("section.retrying")}</p>
        ) : null}
      </div>
    );
  }
  if (job.status === "failed" && job.errorMessage) {
    return (
      <p
        className={cn("line-clamp-2 break-words text-xs text-muted-foreground", className)}
        title={job.errorMessage}
      >
        {job.errorMessage}
      </p>
    );
  }
  if (job.itemCauses && job.itemCauses.length > 0) {
    return <ItemCauseLines causes={job.itemCauses} className={className} />;
  }
  return null;
}
