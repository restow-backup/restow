import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Fact, Facts } from "@/features/endpoints/components/facts";

import type { BackupJob } from "../api.js";
import {
  describeJobSchedule,
  describeScope,
  restoreCheckView,
  retentionLabel,
  scheduleUsesZone,
  scopeNote,
} from "../presenters.js";
import {
  JobStateBadge,
  LastRunCell,
  NextRunCell,
  RepositoryCell,
  RestoreCheckBadge,
} from "./job-cells.js";

/**
 * The key facts of a job: what it covers, when it runs, where it writes, what
 * ran last and what is next, and how its restore checks stand. The actions (run
 * now, edit, pause) sit in the page header; the tabs hold the rest.
 */
export function OverviewTab({
  job,
  onShowScope,
}: {
  job: BackupJob;
  onShowScope: () => void;
}) {
  const { t, i18n } = useTranslation("backupjobs");
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const ctx = { t, tSchedules, language };
  const note = scopeNote(job, t);
  const check = restoreCheckView(job.restoreCheck);

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-slot="job-overview">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("overview.facts")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Facts>
            <Fact label={t("overview.state")}>
              <JobStateBadge state={job.state} />
            </Fact>
            <Fact label={t("overview.scope")}>
              <span>{describeScope(job.scope, job.kind, t, job.copy)}</span>
              {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
            </Fact>
            <Fact label={t("overview.schedule")}>
              {describeJobSchedule(job.schedule, ctx)}
              {scheduleUsesZone(job.schedule) && job.schedule ? (
                <span className="block text-xs text-muted-foreground">{job.schedule.timeZone}</span>
              ) : null}
            </Fact>
            {job.kind === "mail" ? (
              <Fact label={t("overview.restoreCheckSchedule")}>
                {job.verifySchedule ? (
                  describeJobSchedule(job.verifySchedule, ctx)
                ) : (
                  <span className="text-muted-foreground">{t("settings.restoreCheckOff")}</span>
                )}
              </Fact>
            ) : null}
            <Fact label={t("overview.lastRun")}>
              <LastRunCell job={job} />
            </Fact>
            <Fact label={t("overview.nextRun")}>
              <NextRunCell job={job} />
            </Fact>
            <Fact label={t("overview.repository")}>
              <RepositoryCell job={job} />
            </Fact>
            <Fact label={t("overview.retention")}>{retentionLabel(job, t)}</Fact>
          </Facts>
        </CardContent>
      </Card>

      <Card data-slot="job-restore-checks">
        <CardHeader>
          <CardTitle className="text-base">{t("overview.restoreChecks")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RestoreCheckBadge check={job.restoreCheck} />
          {check.state === "none" ? (
            <p className="text-sm text-muted-foreground">{t("overview.restoreChecksNone")}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              <li>{t("restoreCheck.detail.passed", { count: job.restoreCheck.passed })}</li>
              {check.details.map((entry) => (
                <li key={entry.key}>
                  {t(`restoreCheck.detail.${entry.key}`, { count: entry.count })}
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted-foreground">
            {job.restoreCheck.checkedAt ? (
              <>
                {t("overview.lastCheck")}{" "}
                <RelativeTime value={job.restoreCheck.checkedAt} focusable={false} />
              </>
            ) : (
              t("overview.neverChecked")
            )}
          </p>
          <p className="text-xs text-muted-foreground">{t("overview.restoreChecksNote")}</p>
          {job.scope.count > 0 ? (
            <Button variant="outline" size="sm" onClick={onShowScope}>
              {t(`overview.showScope.${job.kind}`)}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
