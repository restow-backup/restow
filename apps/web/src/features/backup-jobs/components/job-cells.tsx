import { Link, useRouterState, useSearch } from "@tanstack/react-router";
import {
  CalendarClock,
  CalendarX,
  CircleDashed,
  CircleX,
  Clock,
  DatabaseZap,
  Hand,
  Info,
  LoaderCircle,
  type LucideIcon,
  Pause,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Countdown } from "@/features/history/components/countdown";
import { OpenRunLink, RunProgressCell } from "@/features/history/components/run-cells";
import { useRunningRunsOf } from "@/features/history/live/provider";
import { activeTenantPageTo } from "@/lib/tenant-paths";
import { cn } from "@/lib/utils";

import type { BackupJob, JobRestoreCheck, JobState } from "../api.js";
import {
  describeJobSchedule,
  describeScope,
  lastRunView,
  nextRunView,
  repositoryLabel,
  restoreCheckView,
  scheduleUsesZone,
  scopeNote,
  stateView,
} from "../presenters.js";

/** The icon of a state: one meaning each (icons table of the 0.2.0 plan). */
const STATE_ICON: Readonly<Record<JobState, LucideIcon>> = {
  paused: Pause,
  failing: CircleX,
  running: LoaderCircle,
  queued: Clock,
  attention: TriangleAlert,
  empty: CircleDashed,
  storage_error: DatabaseZap,
  overdue: CalendarX,
  manual: Hand,
  ok: Info,
};

/** What a job is doing, in one badge. A running job is Lapis and its icon turns (not with reduced motion). */
export function JobStateBadge({ state, className }: { state: JobState; className?: string }) {
  const { t } = useTranslation("backupjobs");
  const view = stateView(state);
  return (
    <StatusBadge
      tone={view.tone}
      icon={view.key === "ok" ? false : STATE_ICON[view.key]}
      className={cn(
        "whitespace-nowrap",
        view.key === "running" && "[&>svg]:motion-safe:animate-spin",
        className,
      )}
      data-state={view.key}
    >
      {t(`state.${view.key}`)}
    </StatusBadge>
  );
}

/**
 * The percent of the job's running backup, beside its state badge. The Last run column holds the
 * full progress; on a phone that column is off screen, so the percent stays with the name.
 */
export function JobLivePercent({ jobId }: { jobId: string }) {
  const lead = useRunningRunsOf(jobId)[0];
  const percent = lead?.progress?.percent;
  if (percent === null || percent === undefined) {
    return null;
  }
  return <span className="font-mono text-xs tabular-nums sm:hidden">{percent} %</span>;
}

const RESTORE_ICON = {
  passed: ShieldCheck,
  attention: ShieldAlert,
  failed: ShieldX,
  none: ShieldQuestion,
} as const;

/**
 * The restore checks of a job's scope: "5 of 6 passed". Green only when every
 * object or machine passed, red when one failed, amber for warnings, objects not
 * checked yet and objects without a backup. The facts that are not "passed" are
 * said in words, so the colour never carries the meaning alone.
 */
export function RestoreCheckBadge({
  check,
  className,
}: { check: JobRestoreCheck; className?: string }) {
  const { t } = useTranslation("backupjobs");
  const view = restoreCheckView(check);
  if (view.state === "none") {
    return <span className="text-muted-foreground">{t("restoreCheck.none")}</span>;
  }
  const detail = view.details
    .map((entry) => t(`restoreCheck.detail.${entry.key}`, { count: entry.count }))
    .join(", ");
  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <StatusBadge
        tone={view.tone}
        icon={RESTORE_ICON[view.state]}
        className="whitespace-nowrap"
        data-restore-check={view.state}
        title={detail || undefined}
      >
        {t("restoreCheck.summary", { passed: view.passed, total: view.total })}
      </StatusBadge>
      {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
    </span>
  );
}

/** What a job covers: "214 mailboxes, 6 OneDrives", and a line for "all" and for overrides. */
export function ScopeCell({ job }: { job: BackupJob }) {
  const { t } = useTranslation("backupjobs");
  const note = scopeNote(job, t);
  return (
    <div className="min-w-0">
      <div>{describeScope(job.scope, job.kind, t)}</div>
      {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
    </div>
  );
}

/** How often a job runs, the zone for clock times, and (mail) how often it checks restores. */
export function ScheduleCell({ job }: { job: BackupJob }) {
  const { t, i18n } = useTranslation("backupjobs");
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const ctx = { t, tSchedules, language };
  return (
    <div className="min-w-0">
      <div className="flex items-start gap-1.5">
        <CalendarClock
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <span>{describeJobSchedule(job.schedule, ctx)}</span>
      </div>
      {scheduleUsesZone(job.schedule) && job.schedule ? (
        <div className="text-xs text-muted-foreground">{job.schedule.timeZone}</div>
      ) : null}
      {job.kind === "mail" ? (
        <div className="text-xs text-muted-foreground">
          {job.verifySchedule
            ? t("schedule.verifyLine", { schedule: describeJobSchedule(job.verifySchedule, ctx) })
            : t("schedule.noVerify")}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The newest backup of the job, and what is running or went wrong. While a backup runs its progress
 * is here, live: the bar, the speed with a small line of it, the time left. The time of the last run
 * is the link that opens that run's drawer (the whole row does the same for the mouse).
 */
export function LastRunCell({ job }: { job: BackupJob }) {
  const { t } = useTranslation("backupjobs");
  const view = lastRunView(job);
  const running = useRunningRunsOf(job.id);
  const lead = running[0];
  const location = useRouterState({ select: (state) => state.location.pathname });
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const runId = job.lastRun.runId;
  return (
    <div className="flex flex-col items-start gap-1">
      {view.running > 0 ? (
        <StatusBadge
          tone="info"
          icon={LoaderCircle}
          className="whitespace-nowrap [&>svg]:motion-safe:animate-spin"
        >
          {t("lastRun.running", { count: view.running })}
        </StatusBadge>
      ) : null}
      {view.queued > 0 ? (
        <StatusBadge tone="muted" icon={Clock} className="whitespace-nowrap">
          {t("lastRun.queued", { count: view.queued })}
        </StatusBadge>
      ) : null}
      {lead ? <RunProgressCell run={lead} /> : null}
      {view.never ? (
        <span className="text-muted-foreground">{t("lastRun.never")}</span>
      ) : view.at ? (
        runId ? (
          <OpenRunLink runId={runId} to={location} search={search}>
            <RelativeTime value={view.at} focusable={false} />
          </OpenRunLink>
        ) : (
          <RelativeTime value={view.at} focusable={false} />
        )
      ) : null}
      {view.failed > 0 ? (
        <StatusBadge tone="destructive" icon={CircleX} className="whitespace-nowrap">
          {t("lastRun.failed", { count: view.failed })}
        </StatusBadge>
      ) : null}
      {view.partial > 0 ? (
        <StatusBadge tone="warning" icon={TriangleAlert} className="whitespace-nowrap">
          {t("lastRun.partial", { count: view.partial })}
        </StatusBadge>
      ) : null}
    </div>
  );
}

/** When the job runs next, or why it does not say. */
export function NextRunCell({ job }: { job: BackupJob }) {
  const { t } = useTranslation("backupjobs");
  const view = nextRunView(job);
  if (view.kind === "at") {
    // Within the hour it counts down, once a second, on the browser's own clock.
    return <Countdown at={view.at} />;
  }
  if (view.kind === "overdue") {
    return (
      <StatusBadge
        tone="warning"
        icon={CalendarX}
        className="whitespace-nowrap"
        data-next="overdue"
      >
        {t("nextRun.overdue")} <RelativeTime value={view.at} focusable={false} />
      </StatusBadge>
    );
  }
  return <span className="text-muted-foreground">{t(`nextRun.${view.kind}`)}</span>;
}

/**
 * Where the job writes, with a warning when that repository fails its check: the backups of the
 * job cannot be stored there. The link leads to the storage page.
 */
export function RepositoryCell({ job }: { job: Pick<BackupJob, "repository"> }) {
  const { t } = useTranslation("backupjobs");
  const label = repositoryLabel(job.repository, t);
  if (job.repository.status !== "error") {
    return (
      <span className="block truncate" title={label}>
        {label}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <span className="block max-w-full truncate" title={label}>
        {label}
      </span>
      <Link
        to={activeTenantPageTo("storage")}
        className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        data-slot="repository-error"
      >
        <StatusBadge tone="destructive" icon={DatabaseZap} className="whitespace-nowrap">
          {t("repository.error")}
        </StatusBadge>
      </Link>
    </span>
  );
}
