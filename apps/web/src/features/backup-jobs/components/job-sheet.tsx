import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, History, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DetailFact, DetailSection, DetailSheet, LogBlock, RelativeTime } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTenantScope } from "@/features/endpoints/hooks";
import { CauseLine } from "@/features/failures/cause-line";
import { fetchHistory, historyKeys, type Run } from "@/features/history/api";
import { RunProgressCell } from "@/features/history/components/run-cells";
import { RunStateBadge, useRunTitle } from "@/features/history/components/run-parts";
import { useLiveOpen } from "@/features/history/live/provider";
import { pveTo } from "@/features/pve/paths";

import type { BackupJob } from "../api.js";
import { jobDefinitionTo } from "../paths.js";
import {
  describeJobSchedule,
  describeScope,
  repositoryLabel,
  restoreCheckView,
  scheduleUsesZone,
} from "../presenters.js";
import type { JobsAccess } from "./access-note.js";
import { JobStateBadge, NextRunCell, RestoreCheckBadge } from "./job-cells.js";
import { JobRunButton, type JobRunControls, useJobActivity } from "./job-run-controls.js";
import {
  isPveRow,
  type JobsListRow,
  type PveListRow,
  PveScheduleCell,
  pveJobState,
} from "./pve-rows.js";

/**
 * The detail panel of a job on the job lists (0.4.5, like the guests' of 0.4.3): everything the
 * row leaves out so it can stay one line. Opened by clicking the row, its name or its state
 * (`?job=<id>`, so a link opens it), closed with Esc or the close button; focus goes back to the
 * job's name in the table. It shows the job's state with what runs and waits, the full error
 * and warning texts of its newest runs (monospace, scrollable, copyable), the restore checks,
 * the key facts, the newest runs, and Start now / Stop beside the other actions.
 */

/** How many of the newest runs the panel lists. */
export const JOB_SHEET_RUNS = 6;

/** The data attribute of a row's name button: where focus returns when the panel closes. */
export const JOB_NAME_ATTRIBUTE = "data-job-name";

export interface JobSheetProps {
  /** The row of the open panel (a job's id, or `pve:<id>`); null keeps it closed. */
  rowId: string | null;
  /** The row as the list has it; null while not found. */
  row: JobsListRow | null;
  loading?: boolean;
  onClose: () => void;
  access: JobsAccess;
  controls: JobRunControls;
  onEdit: (job: BackupJob) => void;
  onEditPve?: (row: PveListRow & { rowType: "pve" }) => void;
}

export function JobSheet({
  rowId,
  row,
  loading = false,
  onClose,
  access,
  controls,
  onEdit,
  onEditPve,
}: JobSheetProps) {
  const { t } = useTranslation("backupjobs");
  const description = row ? (isPveRow(row) ? t("list.type.pve") : t(`sheet.kind.${row.kind}`)) : "";
  return (
    <DetailSheet
      open={rowId !== null}
      onClose={onClose}
      title={row ? row.name : t("sheet.title")}
      description={description}
      loading={!row && loading}
      notFound={!row && !loading ? t("sheet.notFound") : undefined}
      returnFocus={() =>
        rowId
          ? document.querySelector<HTMLElement>(`[${JOB_NAME_ATTRIBUTE}="${CSS.escape(rowId)}"]`)
          : null
      }
      slot="job-sheet"
    >
      {row ? (
        isPveRow(row) ? (
          <PveJobBody row={row} access={access} controls={controls} onEdit={onEditPve} />
        ) : (
          <BackupJobBody job={row} access={access} controls={controls} onEdit={onEdit} />
        )
      ) : null}
    </DetailSheet>
  );
}

/** What runs and waits now, in words, and the progress of the run that leads. */
function ActivityLine({ row }: { row: JobsListRow }) {
  const { t } = useTranslation("backupjobs");
  const activity = useJobActivity(row);
  const parts = [
    activity.running > 0 ? t("lastRun.running", { count: activity.running }) : null,
    activity.queued > 0 ? t("lastRun.queued", { count: activity.queued }) : null,
  ].filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-slot="job-sheet-activity">
      <p className="text-sm">{parts.join(" · ")}</p>
      {activity.lead ? <RunProgressCell run={activity.lead} /> : null}
    </div>
  );
}

/** The newest runs of a job, from History. */
function useJobRuns(jobId: string) {
  const { tenantId, enabled } = useTenantScope();
  const live = useLiveOpen();
  return useQuery({
    queryKey: historyKeys.jobRuns(tenantId, jobId),
    queryFn: () => fetchHistory({ type: null, job: jobId }, null, JOB_SHEET_RUNS * 4),
    enabled,
    // The live channel moves the rows; the texts of a run's end come with the next refresh.
    refetchInterval: live ? 60_000 : 15_000,
  });
}

/** The full text of a run that did not go well, with its cause. */
function RunText({ run, tone }: { run: Run; tone: "destructive" | "warning" }) {
  const { t } = useTranslation("backupjobs");
  return (
    <div className="space-y-2">
      {run.failure ? <CauseLine failure={run.failure} className="text-sm" /> : null}
      {run.errorMessage ? (
        <LogBlock
          text={run.errorMessage}
          tone={tone}
          label={tone === "destructive" ? t("sheet.copyError") : t("sheet.copyWarnings")}
          name={tone === "destructive" ? t("sheet.lastError") : t("sheet.warnings")}
          data-slot={tone === "destructive" ? "job-error" : "job-warnings"}
        />
      ) : null}
    </div>
  );
}

function RecentRuns({ runs }: { runs: readonly Run[] }) {
  const { t } = useTranslation("backupjobs");
  const title = useRunTitle();
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("sheet.noRuns")}</p>;
  }
  return (
    <ol className="space-y-3" data-slot="job-sheet-runs">
      {runs.map((run) => (
        <li key={run.id} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 font-medium break-words">{title(run)}</span>
            <RunStateBadge run={run} />
            <span className="text-muted-foreground">
              <RelativeTime value={run.startedAt ?? run.createdAt} />
            </span>
          </div>
          {run.failure && run.state !== "succeeded" ? <CauseLine failure={run.failure} /> : null}
        </li>
      ))}
    </ol>
  );
}

function BackupJobBody({
  job,
  access,
  controls,
  onEdit,
}: {
  job: BackupJob;
  access: JobsAccess;
  controls: JobRunControls;
  onEdit: (job: BackupJob) => void;
}) {
  const { t, i18n } = useTranslation("backupjobs");
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const runs = useJobRuns(job.id);
  const items = runs.data?.items ?? [];
  const failed = items.find((run) => run.state === "failed");
  const partial = items.find((run) => run.state === "partial" && run.errorMessage);
  const check = restoreCheckView(job.restoreCheck);
  const ctx = { t, tSchedules, language };
  const page = jobDefinitionTo(job.id, job.kind);
  const history = jobDefinitionTo(job.id, job.kind, "runs");
  return (
    <>
      <DetailSection title={t("sheet.state")} slot="job-sheet-state">
        <div className="flex flex-wrap items-center gap-1.5" data-slot="job-states">
          <JobStateBadge state={job.state} />
          {job.lastRun.failed > 0 ? (
            <span className="text-sm text-destructive-text">
              {t("lastRun.failed", { count: job.lastRun.failed })}
            </span>
          ) : null}
          {job.lastRun.partial > 0 ? (
            <span className="text-sm text-warning-text">
              {t("lastRun.partial", { count: job.lastRun.partial })}
            </span>
          ) : null}
        </div>
        <ActivityLine row={job} />
      </DetailSection>

      <div className="flex flex-wrap gap-2" data-slot="job-sheet-actions">
        <JobRunButton row={job} controls={controls} access={access} className="justify-start" />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={access.closed}
          aria-describedby={access.closed ? access.noteId : undefined}
          onClick={() => onEdit(job)}
        >
          <Pencil aria-hidden="true" />
          {t("actions.edit")}
        </Button>
        <Link
          to={history.to}
          search={history.search as never}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <History aria-hidden="true" />
          {t("actions.openHistory")}
        </Link>
        <Link
          to={page.to}
          search={page.search as never}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          data-slot="job-sheet-open"
        >
          <ExternalLink aria-hidden="true" />
          {t("sheet.openPage")}
        </Link>
      </div>

      {failed ? (
        <DetailSection title={t("sheet.lastError")} slot="job-sheet-error">
          <p className="text-xs text-muted-foreground">
            {failed.subject?.name ? `${failed.subject.name} · ` : ""}
            <RelativeTime value={failed.finishedAt ?? failed.startedAt ?? failed.createdAt} />
          </p>
          <RunText run={failed} tone="destructive" />
        </DetailSection>
      ) : null}

      {partial ? (
        <DetailSection title={t("sheet.warnings")} slot="job-sheet-warnings">
          <p className="text-xs text-muted-foreground">
            {partial.subject?.name ? `${partial.subject.name} · ` : ""}
            <RelativeTime value={partial.finishedAt ?? partial.startedAt ?? partial.createdAt} />
          </p>
          <RunText run={partial} tone="warning" />
        </DetailSection>
      ) : null}

      <DetailSection title={t("sheet.restoreCheck")} slot="job-sheet-verify">
        <RestoreCheckBadge check={job.restoreCheck} />
        {check.details.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {check.details.map((entry) => (
              <li key={entry.key}>
                {t(`restoreCheck.detail.${entry.key}`, { count: entry.count })}
              </li>
            ))}
          </ul>
        ) : null}
        {job.restoreCheck.checkedAt ? (
          <dl>
            <DetailFact label={t("sheet.checkedAt")}>
              <RelativeTime value={job.restoreCheck.checkedAt} />
            </DetailFact>
          </dl>
        ) : null}
      </DetailSection>

      <DetailSection title={t("sheet.facts")} slot="job-sheet-facts">
        <dl className="space-y-1.5">
          <DetailFact label={t("list.columns.scope")}>
            {describeScope(job.scope, job.kind, t, job.copy)}
          </DetailFact>
          <DetailFact label={t("list.columns.schedule")}>
            {describeJobSchedule(job.schedule, ctx)}
            {scheduleUsesZone(job.schedule) && job.schedule ? (
              <span className="block text-xs text-muted-foreground">{job.schedule.timeZone}</span>
            ) : null}
          </DetailFact>
          {job.kind === "mail" ? (
            <DetailFact label={t("sheet.verifySchedule")}>
              {job.verifySchedule
                ? describeJobSchedule(job.verifySchedule, ctx)
                : t("schedule.noVerify")}
            </DetailFact>
          ) : null}
          <DetailFact label={t("list.columns.repository")}>
            {repositoryLabel(job.repository, t)}
          </DetailFact>
          <DetailFact label={t("list.columns.lastRun")}>
            <RelativeTime value={job.lastRun.at} fallback={t("lastRun.never")} />
          </DetailFact>
          <DetailFact label={t("list.columns.nextRun")}>
            <NextRunCell job={job} />
          </DetailFact>
        </dl>
      </DetailSection>

      <DetailSection title={t("sheet.runs")}>
        {runs.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <RecentRuns runs={items.slice(0, JOB_SHEET_RUNS)} />
        )}
      </DetailSection>
    </>
  );
}

function PveJobBody({
  row,
  access,
  controls,
  onEdit,
}: {
  row: PveListRow;
  access: JobsAccess;
  controls: JobRunControls;
  onEdit?: (row: PveListRow & { rowType: "pve" }) => void;
}) {
  const { t } = useTranslation("backupjobs");
  if (row.rowType === "manual") {
    return (
      <>
        <DetailSection title={t("sheet.state")} slot="job-sheet-state">
          <JobStateBadge state={row.guest.activity === "running" ? "running" : "queued"} />
        </DetailSection>
        <div className="flex flex-wrap gap-2" data-slot="job-sheet-actions">
          <JobRunButton row={row} controls={controls} access={access} className="justify-start" />
        </div>
      </>
    );
  }
  const job = row.job;
  const round = job.round;
  const keep = job.settings.retention;
  return (
    <>
      <DetailSection title={t("sheet.state")} slot="job-sheet-state">
        <div className="flex flex-wrap items-center gap-1.5" data-slot="job-states">
          <JobStateBadge state={pveJobState(job)} />
        </div>
        {round ? (
          <p className="text-sm" data-slot="job-sheet-activity">
            {[
              t("list.pve.round", { done: round.done, total: round.total }),
              round.running > 0 ? t("lastRun.running", { count: round.running }) : null,
              round.queued > 0 ? t("lastRun.queued", { count: round.queued }) : null,
              round.failed > 0 ? t("lastRun.failed", { count: round.failed }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
      </DetailSection>

      <div className="flex flex-wrap gap-2" data-slot="job-sheet-actions">
        <JobRunButton row={row} controls={controls} access={access} className="justify-start" />
        {onEdit ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={access.closed}
            aria-describedby={access.closed ? access.noteId : undefined}
            onClick={() => onEdit(row as PveListRow & { rowType: "pve" })}
          >
            <Pencil aria-hidden="true" />
            {t("actions.edit")}
          </Button>
        ) : null}
        <Link
          {...pveTo()}
          search={{ job: job.id } as never}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          data-slot="job-sheet-open"
        >
          <ExternalLink aria-hidden="true" />
          {t("sheet.openGuests")}
        </Link>
      </div>

      {round && round.failed > 0 ? (
        <DetailSection title={t("sheet.lastError")} slot="job-sheet-error">
          <p className="text-sm">{t("sheet.pveFailed", { count: round.failed })}</p>
          <Link
            {...pveTo()}
            search={{ job: job.id, state: "failed" } as never}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {t("sheet.pveShowFailed")}
          </Link>
        </DetailSection>
      ) : null}

      <DetailSection title={t("sheet.restoreCheck")} slot="job-sheet-verify">
        <p className="text-sm">{t("sheet.pveRestoreCheck")}</p>
      </DetailSection>

      <DetailSection title={t("sheet.facts")} slot="job-sheet-facts">
        <dl className="space-y-1.5">
          <DetailFact label={t("list.columns.scope")}>
            {t("list.pve.guests", { count: job.guestCount ?? 0 })}
            {job.scopeAll ? (
              <span className="block text-xs text-muted-foreground">{t("list.pve.scopeAll")}</span>
            ) : null}
          </DetailFact>
          <DetailFact label={t("list.columns.schedule")}>
            <PveScheduleCell row={row} />
          </DetailFact>
          {keep ? (
            <DetailFact label={t("sheet.keep")}>
              {t("sheet.keepValue", {
                daily: keep.keepDaily,
                weekly: keep.keepWeekly,
                monthly: keep.keepMonthly,
              })}
            </DetailFact>
          ) : null}
          <DetailFact label={t("list.columns.lastRun")}>
            <RelativeTime value={job.lastRunAt} fallback={t("lastRun.never")} />
          </DetailFact>
          <DetailFact label={t("list.columns.nextRun")}>
            <RelativeTime
              value={job.nextRunAt}
              fallback={t(job.enabled ? "nextRun.manual" : "nextRun.paused")}
            />
          </DetailFact>
        </dl>
      </DetailSection>
    </>
  );
}
