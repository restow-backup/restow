import { Link } from "@tanstack/react-router";
import { Check, ChevronRight } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FailureExplanation, useCauseTitle } from "@/features/failures";
import { jobDetailTo } from "@/features/jobs/paths";
import { phaseLabel } from "@/features/jobs/presenters";
import { formatBytes, formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { Run, RunDetail, RunEvent, RunObject } from "../api";
import { useSecondClock } from "../live/clock";
import {
  barPercent,
  eventView,
  isMailSubject,
  runDurationSeconds,
  savingsPercent,
  stateView,
  waveProgress,
} from "../presenters";
import { formatClock } from "../samples";
import { RestoreCheckChip, RunStateBadge, SubjectIcon, useRunTitle } from "./run-parts";
import { ThroughputCharts } from "./throughput-charts";

/**
 * What a run looks like, drawer and page alike: its progress, three columns of numbers
 * (summary, data, result), the throughput as two small charts, then the objects of its wave and
 * its timeline. A run that is going is live: the numbers come from the channel, the clock under
 * the duration ticks here, and nothing asks the server. The parts only the server can derive
 * (objects, timeline, restore check) come with the detail and wait behind skeletons.
 */

export interface RunViewProps {
  run: Run;
  detail: RunDetail | undefined;
  /** The detail is still loading. */
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Switch to another run of the wave (the objects are buttons). */
  onOpenRun?: (runId: string) => void;
  /**
   * The page of the run lists the failed items in full below the view (mail runs); the drawer
   * shows the first ones here, with the way to that page.
   */
  itemsOnPage?: boolean;
  className?: string;
}

export function RunView({
  run,
  detail,
  loading,
  error,
  onRetry,
  onOpenRun,
  itemsOnPage = false,
  className,
}: RunViewProps) {
  const { t } = useTranslation("history");
  const running = run.state === "running";
  const now = useSecondClock(running);

  return (
    <div className={cn("space-y-5", className)} data-slot="run-view" data-state={run.state}>
      <FailureSection run={run} detail={detail} />
      {itemsOnPage ? null : <FailedItemsSection run={run} detail={detail} />}
      <ProgressSection run={run} detail={detail} />
      <StatsSection run={run} detail={detail} now={now} />
      <ChartsSection run={run} loading={loading && !run.samples} detail={detail} />
      {error && !detail ? (
        <ErrorState title={t("view.loadError")} error={error} onRetry={onRetry} />
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <ObjectsSection run={run} detail={detail} loading={loading} onOpenRun={onOpenRun} />
          <TimelineSection run={run} detail={detail} loading={loading} />
        </div>
      )}
    </div>
  );
}

// --- Why it failed ------------------------------------------------------------------------------

function FailureSection({ run, detail }: { run: Run; detail: RunDetail | undefined }) {
  const { t } = useTranslation("history");
  const title = useRunTitle();
  const retrying = run.state === "queued" || run.state === "running";
  const failed = run.state === "failed" || run.state === "partial";
  if (!(failed && (run.failure || run.errorMessage)) && !(retrying && run.failure)) {
    return null;
  }
  return (
    <FailureExplanation
      failure={run.failure}
      message={run.errorMessage}
      subject={{
        kind: "job",
        queue: t(`kind.${run.kind}`),
        object: run.subject?.name ?? null,
      }}
      at={run.finishedAt ?? run.updatedAt}
      docsUrl={detail?.docsUrl ?? null}
      affectedItems={run.progress?.itemsFailed ?? 0}
      retrying={retrying}
      // A restore check that could not complete proves nothing about the backup: neutral.
      tone={run.checkIncomplete ? "info" : undefined}
      className="[&_*]:break-words"
      aria-label={title(run)}
    />
  );
}

// --- What was left behind -----------------------------------------------------------------------

/** Items shown in the drawer; the page of the run lists them all. */
const DRAWER_ITEMS = 5;

/**
 * A run that went through but left items behind (`partial`) has no failure of its own: without
 * this section the drawer would show a warning badge and nothing to explain it. It lists the first
 * failed items with their cause and raw message, and leads to the page of the run, which groups
 * them by cause with what to do.
 */
function FailedItemsSection({ run, detail }: { run: Run; detail: RunDetail | undefined }) {
  const { t } = useTranslation("history");
  const causeTitle = useCauseTitle();
  const errors = detail?.errors ?? [];
  if (run.state === "running" || run.state === "queued" || errors.length === 0) {
    return null;
  }
  const shown = errors.slice(0, DRAWER_ITEMS);
  const more = Math.max(detail?.errorCount ?? errors.length, errors.length) - shown.length;
  return (
    <section
      aria-label={t("view.items.title")}
      className="space-y-2 rounded-[10px] border border-warning/40 bg-warning/5 p-3"
      data-section="failed-items"
    >
      <h3 className="text-[12.5px] font-semibold">{t("view.items.title")}</h3>
      <ul className="space-y-1.5 text-[12.5px]">
        {shown.map((error, index) => (
          <li
            key={`${index}-${error.path ?? ""}`}
            className="min-w-0"
            data-cause={error.cause ?? undefined}
          >
            {error.path ? (
              <p className="truncate font-mono text-[11.5px]" title={error.path}>
                {error.path}
              </p>
            ) : null}
            <p className="break-words">{causeTitle(error.cause ?? "unknown")}</p>
            <p className="break-words text-xs text-muted-foreground">{error.message}</p>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <p className="text-xs text-muted-foreground">{t("view.items.more", { count: more })}</p>
      ) : null}
      <Link
        to={jobDetailTo(run.id)}
        className="inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
      >
        {t("view.items.open")}
        <ChevronRight aria-hidden="true" className="size-3" />
      </Link>
    </section>
  );
}

// --- Progress -------------------------------------------------------------------------------------

function ProgressSection({ run, detail }: { run: Run; detail: RunDetail | undefined }) {
  const { t, i18n } = useTranslation("history");
  const { t: tb } = useTranslation("backup");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const view = stateView(run);
  const percent = barPercent(run);
  const running = run.state === "running";
  const indeterminate = percent === null && running;
  const wave = waveProgress(detail?.batch ?? null);
  const progress = run.progress;
  const waveNoun = run.subject ? run.subject.kind : "mailbox";
  const phaseOf = phaseLabel(run.phase?.name ?? "");

  const headline = running
    ? percent === null
      ? t("view.progress.discovering")
      : t("view.progress.percent", { percent })
    : t(`state.${view.key}`);
  const detailText = wave
    ? t(`view.wave.${run.kind === "backup" ? waveNoun : "generic"}`, wave)
    : progress && progress.itemsTotal !== null
      ? t("view.progress.items", {
          done: formatInteger(progress.itemsDone, language),
          total: formatInteger(progress.itemsTotal, language),
        })
      : progress && progress.itemsDone > 0
        ? t("view.progress.itemsOpen", { done: formatInteger(progress.itemsDone, language) })
        : null;

  return (
    <section aria-label={t("view.progress.label")} className="space-y-2" data-section="progress">
      <div className="flex items-baseline justify-between gap-3">
        <b className="font-mono text-[15px] font-medium tabular-nums">{headline}</b>
        {detailText ? <span className="text-xs text-muted-foreground">{detailText}</span> : null}
      </div>
      {/* The native element carries the semantics; the bar below is the picture of it. */}
      <progress
        className="sr-only"
        aria-label={t("view.progress.label")}
        aria-valuetext={`${headline}${detailText ? `, ${detailText}` : ""}`}
        max={100}
        value={indeterminate || percent === null ? undefined : Math.round(percent)}
      />
      <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700 ease-linear motion-reduce:transition-none",
            run.state === "running" && "bg-info",
            run.state === "queued" && "bg-muted-foreground/30",
            (run.state === "succeeded" || run.state === "partial") && "bg-muted-foreground",
            run.state === "failed" && "bg-destructive",
            run.state === "cancelled" && "bg-muted-foreground/50",
            indeterminate && "w-full opacity-40 motion-safe:animate-pulse",
          )}
          style={indeterminate ? undefined : { width: `${percent ?? 0}%` }}
        />
      </div>
      {running && progress?.currentPath ? (
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={progress.currentPath}
        >
          {t("view.progress.reading", { path: progress.currentPath })}
        </p>
      ) : null}
      {running && run.phase ? (
        <p className="text-xs text-muted-foreground">
          {t("view.progress.phase", { phase: tb(phaseOf.key, phaseOf.values) })}
        </p>
      ) : null}
    </section>
  );
}

// --- The three columns ------------------------------------------------------------------------------

function Row({
  label,
  children,
  term,
}: {
  label: string;
  children: React.ReactNode;
  term?: string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 text-right font-mono tabular-nums break-words" data-term={term}>
        {children}
      </dd>
    </>
  );
}

function StatsSection({
  run,
  detail,
  now,
}: {
  run: Run;
  detail: RunDetail | undefined;
  now: number;
}) {
  const { t, i18n } = useTranslation("history");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const running = run.state === "running";
  const progress = run.progress;
  const seconds = runDurationSeconds(run, now);
  const processed = progress?.bytesProcessed ?? 0;
  const transferred = progress?.bytesTransferred ?? 0;
  const savings = savingsPercent(processed, transferred);
  const rate = (value: number) => t("units.perSecond", { value: formatBytes(value, language) });
  // A finished run's speed is what it read over the time it took.
  const average = !running && seconds && seconds > 0 && processed > 0 ? processed / seconds : null;
  const wave = detail?.batch ?? null;
  const passed =
    detail?.objects.filter((object) => object.restoreCheck.state === "passed").length ?? 0;
  const failedItems = progress?.itemsFailed ?? 0;
  const backedUp = wave
    ? wave.succeeded + wave.partial
    : (detail?.summary?.itemsWritten ?? progress?.itemsDone ?? null);
  const showSpeed = run.kind !== "maintenance" && (running ? run.throughput : average);

  return (
    <section
      aria-label={t("view.stats.label")}
      className="grid grid-cols-1 rounded-[10px] border border-border sm:grid-cols-[repeat(3,minmax(0,1fr))] sm:divide-x"
      data-section="stats"
    >
      <div className="min-w-0 p-3">
        <h3 className="mb-2 text-[12.5px] font-semibold">{t("view.stats.summary")}</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
          <Row label={t("view.stats.duration")} term="duration">
            {seconds === null ? "–" : formatClock(seconds)}
          </Row>
          {showSpeed ? (
            <Row label={t(running ? "view.stats.speed" : "view.stats.averageSpeed")} term="speed">
              {running ? rate(run.throughput?.processedBps ?? 0) : rate(average ?? 0)}
            </Row>
          ) : null}
          {running ? (
            <Row label={t("view.stats.remaining")} term="remaining">
              {progress?.etaSeconds != null
                ? t("view.stats.about", { time: formatClock(progress.etaSeconds) })
                : "–"}
            </Row>
          ) : (
            <Row label={t("view.stats.ended")} term="ended">
              {run.finishedAt
                ? new Intl.DateTimeFormat(language, { timeStyle: "medium" }).format(
                    new Date(run.finishedAt),
                  )
                : "–"}
            </Row>
          )}
        </dl>
      </div>
      <div className="min-w-0 border-t p-3 sm:border-t-0">
        <h3 className="mb-2 text-[12.5px] font-semibold">{t("view.stats.data")}</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
          <Row label={t("view.stats.processed")} term="processed">
            {formatBytes(processed, language)}
            {running && progress?.percent != null ? ` (${progress.percent} %)` : ""}
          </Row>
          <Row label={t("view.stats.new")} term="new">
            {progress?.bytesNew != null ? formatBytes(progress.bytesNew, language) : "–"}
          </Row>
          <Row label={t("view.stats.transferred")} term="transferred">
            {formatBytes(transferred, language)}
            {savings !== null && transferred > 0
              ? ` · ${t("view.stats.saved", { percent: new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(savings) })}`
              : ""}
          </Row>
        </dl>
      </div>
      <div className="min-w-0 border-t p-3 sm:border-t-0">
        <h3 className="mb-2 text-[12.5px] font-semibold">{t("view.stats.result")}</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
          <Row
            label={t(run.kind === "backup" ? "view.stats.backedUp" : "view.stats.items")}
            term="backed-up"
          >
            {backedUp === null ? "–" : formatInteger(backedUp, language)}
          </Row>
          {run.kind === "backup" || run.kind === "restore_check" ? (
            <Row label={t("view.stats.restoreCheck")} term="restore-check">
              {detail ? (
                wave && run.kind === "backup" ? (
                  t("view.stats.checksPassed", { passed, total: wave.total })
                ) : detail.restoreCheck.state === "none" ? (
                  "–"
                ) : (
                  <RestoreCheckChip
                    check={detail.restoreCheck}
                    className="font-sans whitespace-normal"
                  />
                )
              ) : (
                "–"
              )}
            </Row>
          ) : null}
          <Row label={t("view.stats.failedItems")} term="failed-items">
            <span className={cn(failedItems > 0 && "text-warning-foreground dark:text-warning")}>
              {formatInteger(failedItems, language)}
            </span>
          </Row>
        </dl>
      </div>
    </section>
  );
}

// --- Charts -------------------------------------------------------------------------------------------

function ChartsSection({
  run,
  loading,
  detail,
}: {
  run: Run;
  loading: boolean;
  detail: RunDetail | undefined;
}) {
  const { t } = useTranslation("history");
  const points = detail?.samples ?? run.samples ?? [];
  const running = run.state === "running";
  const hasTransfer = run.kind === "backup" || points.some((point) => point[2] > 0);
  return (
    <section aria-label={t("view.charts.label")} className="space-y-2" data-section="charts">
      {points.length >= 2 ? (
        <ThroughputCharts points={points} running={running} showTransferred={hasTransfer} />
      ) : loading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          {running || run.state === "queued" ? t("view.charts.waiting") : t("view.charts.none")}
        </p>
      )}
    </section>
  );
}

// --- Objects --------------------------------------------------------------------------------------------

function ObjectsSection({
  run,
  detail,
  loading,
  onOpenRun,
}: {
  run: Run;
  detail: RunDetail | undefined;
  loading: boolean;
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useTranslation("history");
  const objects = detail?.objects ?? [];
  const noun = run.subject && !isMailSubject(run.subject.kind) ? "machines" : "mailboxes";
  return (
    <section
      aria-label={t(`view.objects.${noun}`)}
      className="min-w-0 rounded-[10px] border border-border p-3"
      data-section="objects"
    >
      <h3 className="mb-2 text-[12.5px] font-semibold">{t(`view.objects.${noun}`)}</h3>
      {loading && !detail ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      ) : objects.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("view.objects.empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {objects.map((object) => (
            <ObjectRow
              key={object.runId ?? object.subject.id}
              object={object}
              onOpenRun={onOpenRun}
            />
          ))}
        </ul>
      )}
      {detail?.batch?.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("view.objects.truncated")}</p>
      ) : null}
    </section>
  );
}

function ObjectRow({
  object,
  onOpenRun,
}: {
  object: RunObject;
  onOpenRun?: (runId: string) => void;
}) {
  const { t } = useTranslation("history");
  // The name keeps its room; when the badges do not fit beside it they drop to a line of their own.
  const content = (
    <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <span className="flex min-w-0 flex-1 basis-36 items-center gap-2">
        <SubjectIcon kind={object.subject.kind} className="text-muted-foreground" />
        <span className="truncate font-mono text-[12.5px]">{object.subject.name}</span>
        {object.current ? (
          <Check aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
      </span>
      <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <RunStateBadge run={{ state: object.state, kind: "backup", checkIncomplete: false }} />
        <RestoreCheckChip check={object.restoreCheck} />
      </span>
    </span>
  );
  const switchable = onOpenRun && object.runId && !object.current;
  return (
    <li className="py-1.5" data-current={object.current || undefined}>
      {switchable ? (
        <button
          type="button"
          onClick={() => onOpenRun(object.runId as string)}
          aria-label={t("view.objects.open", { name: object.subject.name })}
          className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {content}
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      ) : (
        <div
          aria-current={object.current ? "true" : undefined}
          className="flex items-center justify-between gap-2 px-1 py-0.5"
        >
          {content}
        </div>
      )}
    </li>
  );
}

// --- Timeline ---------------------------------------------------------------------------------------------

function TimelineSection({
  run,
  detail,
  loading,
}: {
  run: Run;
  detail: RunDetail | undefined;
  loading: boolean;
}) {
  const { t, i18n } = useTranslation("history");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const clock = React.useMemo(
    () => new Intl.DateTimeFormat(language, { timeStyle: "medium" }),
    [language],
  );
  return (
    <section
      aria-label={t("view.log.title")}
      className="min-w-0 rounded-[10px] border border-border p-3"
      data-section="timeline"
    >
      <h3 className="mb-2 text-[12.5px] font-semibold">{t("view.log.title")}</h3>
      {loading && !detail ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : (
        <ol className="divide-y divide-border">
          {(detail?.events ?? []).map((event, index) => (
            <TimelineLine key={`${event.at}-${event.type}-${index}`} event={event} clock={clock} />
          ))}
        </ol>
      )}
      {detail?.logTail ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            {t("view.log.agent")}
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11.5px] whitespace-pre-wrap">
            {detail.logTail}
          </pre>
        </details>
      ) : null}
      {detail && detail.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("view.log.empty")}</p>
      ) : null}
    </section>
  );
}

function TimelineLine({ event, clock }: { event: RunEvent; clock: Intl.DateTimeFormat }) {
  const { t } = useTranslation("history");
  const { t: tb } = useTranslation("backup");
  const view = eventView(event);
  if (view.key === "phase") {
    // The step is an engine phase; the `backup` namespace names them.
    const phase = phaseLabel(String(view.values.phase));
    view.values = { phase: tb(phase.key, phase.values) };
  }
  return (
    <li className="grid grid-cols-[4.75rem_minmax(0,1fr)_2.75rem] items-baseline gap-2 py-1.5 text-[12.5px]">
      <time
        dateTime={event.at}
        className="font-mono text-[11.5px] text-muted-foreground tabular-nums"
      >
        {clock.format(new Date(event.at))}
      </time>
      <span className="min-w-0 break-words">{t(`events.${view.key}`, view.values)}</span>
      <span className="text-right font-mono text-[11.5px] text-muted-foreground tabular-nums">
        {event.durationMs !== null && event.durationMs >= 1000
          ? formatClock(event.durationMs / 1000)
          : ""}
      </span>
    </li>
  );
}
