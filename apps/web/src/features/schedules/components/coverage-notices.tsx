import { Link } from "@tanstack/react-router";
import { Eye, Info, ListChecks, Sparkles, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { jobsListTo, linkProps } from "@/features/backup-jobs/paths";

import type { ScheduleList } from "../api.js";
import { JOB_REPLACED_KINDS, maintenanceKinds } from "../presenters.js";

export interface CoverageNoticesProps {
  list: ScheduleList;
  /** How many older backup or restore-check schedules are listed (they keep running next to the jobs). */
  legacy: number;
  canManage: boolean;
  /** Add the missing recommended schedules (and, where no job covers all objects, the default mail job). */
  onApplyRecommended: () => void;
  applying: boolean;
  /** Offer that action here; the page may offer it elsewhere (an empty state) and not twice. */
  showApply?: boolean;
}

/**
 * The plain truth above the table: that no job backs up all objects (the server
 * says so with `backup` or `verify` among the missing kinds: no mail job covers
 * all objects and no older schedule exists), the maintenance not set up yet, the
 * older backup schedules that keep running next to the jobs, what retention does,
 * and that tenant users look but do not change. Each problem comes with the
 * action that fixes it (for administrators); the recommended set also creates the
 * default mail job.
 */
export function CoverageNotices({
  list,
  legacy,
  canManage,
  onApplyRecommended,
  applying,
  showApply = true,
}: CoverageNoticesProps) {
  const { t } = useTranslation("schedules");
  const noJob = list.missingKinds.some((kind) => JOB_REPLACED_KINDS.includes(kind));
  const missing = maintenanceKinds(list.missingKinds);
  const hasRetention = list.items.some((item) => item.kind === "retention" && item.enabled);

  const applyButton = (
    <Button size="sm" variant="outline" onClick={onApplyRecommended} loading={applying}>
      <Sparkles aria-hidden="true" />
      {t("actions.applyRecommended")}
    </Button>
  );

  return (
    <div className="space-y-3" data-slot="coverage-notices">
      {!canManage ? (
        <Alert variant="info">
          <Eye aria-hidden="true" />
          <AlertDescription>{t("notices.readOnly")}</AlertDescription>
        </Alert>
      ) : null}

      {noJob ? (
        <Alert variant="warning" data-notice="jobs">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t("notices.noJob.title")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("notices.noJob.description")}</span>
            <span className="flex shrink-0 flex-wrap gap-2">
              <Link
                {...linkProps(jobsListTo("mail"))}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <ListChecks aria-hidden="true" />
                {t("notices.noJob.open")}
              </Link>
              {canManage && showApply ? applyButton : null}
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {missing.length > 0 ? (
        <Alert variant="info" data-notice="recommended">
          <Sparkles aria-hidden="true" />
          <AlertTitle>{t("notices.recommended.title")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {t("notices.recommended.description", {
                kinds: missing.map((kind) => t(`kinds.${kind}`)).join(", "),
              })}
            </span>
            {canManage && showApply && !noJob ? applyButton : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {legacy > 0 ? (
        <Alert data-notice="legacy">
          <Info aria-hidden="true" />
          <AlertDescription>{t("notices.legacy", { count: legacy })}</AlertDescription>
        </Alert>
      ) : null}

      {hasRetention ? (
        <Alert data-notice="retention">
          <Info aria-hidden="true" />
          <AlertDescription>{t("notices.retention")}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
