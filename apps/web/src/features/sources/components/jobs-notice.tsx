import { Link } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { useBackupJobs } from "@/features/backup-jobs/hooks";
import { jobsListTo, linkProps } from "@/features/backup-jobs/paths";
import { directoryTo } from "@/features/directory/search";

/**
 * The step after connecting a source: its mailboxes and OneDrives are backed up only once a
 * backup job that runs on a schedule covers them. Shown under the sources while some objects
 * are in no job, or only in paused or manual ones, with the way to them and to the jobs.
 */
export function SourcesJobsNotice() {
  const { t } = useTranslation("sources");
  const jobs = useBackupJobs("mail");
  const none = jobs.data?.uncovered.mail ?? 0;
  const unscheduled = jobs.data?.unscheduled?.mail ?? 0;
  if (none + unscheduled === 0) {
    return null;
  }
  return (
    <Alert variant="warning" data-slot="sources-jobs-notice">
      <ShieldOff aria-hidden="true" />
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{t("jobsNotice.text", { count: none + unscheduled })}</span>
        <span className="flex shrink-0 gap-2">
          <Link
            to={directoryTo()}
            search={{ job: none > 0 ? "none" : "unscheduled" } as never}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {t("jobsNotice.show")}
          </Link>
          <Link
            {...linkProps(jobsListTo("mail"))}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {t("jobsNotice.jobs")}
          </Link>
        </span>
      </AlertDescription>
    </Alert>
  );
}
