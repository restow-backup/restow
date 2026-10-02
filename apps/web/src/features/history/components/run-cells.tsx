import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit";
import { CauseLine } from "@/features/failures";
import { formatBytes, formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { Run } from "../api";
import { useSecondClock } from "../live/clock";
import { barPercent, runDurationSeconds, withRun } from "../presenters";
import { formatClock } from "../samples";
import { Sparkline } from "./sparkline";

/** The cells of a row that shows a run, shared by History and the job list. */

/** The bar of a row: Lapis while the run runs, neutral once it completed (green is proof, not completion). */
export function RunBar({
  run,
  className,
}: { run: Pick<Run, "state" | "progress">; className?: string }) {
  const percent = barPercent(run);
  const indeterminate = percent === null && run.state === "running";
  return (
    <div
      aria-hidden="true"
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
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
  );
}

/**
 * What a running run is doing, for a row: the bar, the sparkline with the speed and the time left;
 * for a run that is not running a line of what it did.
 */
export function RunProgressCell({ run }: { run: Run }) {
  const { t, i18n } = useTranslation("history");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const progress = run.progress;
  const rate = (value: number) => t("units.perSecond", { value: formatBytes(value, language) });

  if (run.state === "queued") {
    return <span className="text-xs text-muted-foreground">{t("row.waiting")}</span>;
  }
  if (!progress) {
    return <span className="text-xs text-muted-foreground">–</span>;
  }
  const parts = [
    progress.itemsTotal !== null
      ? t("row.items", {
          done: formatInteger(progress.itemsDone, language),
          total: formatInteger(progress.itemsTotal, language),
        })
      : progress.itemsDone > 0
        ? t("row.itemsOpen", { done: formatInteger(progress.itemsDone, language) })
        : null,
    progress.bytesProcessed > 0 ? formatBytes(progress.bytesProcessed, language) : null,
  ].filter((part): part is string => part !== null);

  if (run.state !== "running") {
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground tabular-nums">{parts.join(" · ") || "–"}</p>
        {progress.itemsFailed > 0 ? (
          <p className="text-xs text-warning-foreground dark:text-warning">
            {t("row.failedItems", { count: progress.itemsFailed })}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="min-w-60 space-y-1.5" data-slot="run-progress">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono tabular-nums font-medium">
          {progress.percent === null ? t("row.discovering") : `${progress.percent} %`}
        </span>
        <span className="text-muted-foreground tabular-nums">{parts.join(" · ")}</span>
      </div>
      <RunBar run={run} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs whitespace-nowrap text-muted-foreground">
        <Sparkline points={run.samples} />
        {run.throughput ? (
          <span className="font-mono tabular-nums text-foreground">
            {rate(run.throughput.processedBps)}
          </span>
        ) : null}
        {progress.etaSeconds != null ? (
          <span className="tabular-nums">
            {t("row.remaining", { time: formatClock(progress.etaSeconds) })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** How long a run took; a running one counts on, once a second, without asking anybody. */
export function RunDuration({ run }: { run: Pick<Run, "state" | "startedAt" | "finishedAt"> }) {
  const now = useSecondClock(run.state === "running");
  const seconds = runDurationSeconds(run, now);
  return (
    <span className="font-mono tabular-nums text-muted-foreground">
      {seconds === null ? "–" : formatClock(seconds)}
    </span>
  );
}

/** When a run started: relative, with the exact time on hover. */
export function RunStarted({ run }: { run: Pick<Run, "startedAt" | "createdAt"> }) {
  return <RelativeTime value={run.startedAt ?? run.createdAt} focusable={false} />;
}

/** Why a run did not go well, in a line for a table: the cause, or the recorded message. */
export function RunCause({ run, className }: { run: Run; className?: string }) {
  const { t } = useTranslation("failures");
  const failedLike = run.state === "failed" || run.state === "queued";
  if (run.failure && failedLike) {
    return (
      <div className={cn("space-y-0.5", className)}>
        <CauseLine failure={run.failure} />
        {run.failure.retry && run.state === "queued" ? (
          <p className="text-xs text-muted-foreground">{t("section.retrying")}</p>
        ) : null}
      </div>
    );
  }
  if (run.state === "failed" && run.errorMessage) {
    return (
      <p
        className={cn("line-clamp-2 break-words text-xs text-muted-foreground", className)}
        title={run.errorMessage}
      >
        {run.errorMessage}
      </p>
    );
  }
  return null;
}

/** The link of a row that opens the run's drawer: a real address, so it can be copied and opened elsewhere. */
export function OpenRunLink({
  runId,
  search,
  to,
  children,
  className,
  label,
}: {
  runId: string;
  /** The search of the page the drawer opens on. */
  search: Record<string, unknown>;
  /** The path of that page. */
  to: string;
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <Link
      to={to as never}
      search={withRun(search, runId) as never}
      aria-label={label}
      className={cn(
        "rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      {children}
    </Link>
  );
}
