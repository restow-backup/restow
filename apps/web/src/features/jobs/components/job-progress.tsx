import { Hourglass, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Job } from "@/features/jobs/api";
import {
  type ThrottledRun,
  isWaitingForThrottle,
  progressBytesKey,
  progressCountKey,
  progressRatio,
  throttleRemainingMs,
} from "@/features/jobs/presenters";
import { useJobFormat } from "@/features/jobs/use-format";
import { cn } from "@/lib/utils";

const BAR_TONE: Record<Job["status"], string> = {
  queued: "bg-muted-foreground/30",
  active: "bg-primary",
  // A completed run is full, not green: green means a passed restore check.
  completed: "bg-muted-foreground",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/50",
};

/**
 * The progress bar of a job. While the total is unknown (discovery still
 * running) it pulses instead of pretending a percentage.
 */
export function ProgressBar({ job, className }: { job: Job; className?: string }) {
  const { t, integer } = useJobFormat();
  const ratio = progressRatio(job.progress);
  const indeterminate = ratio === null && job.status === "active";
  const percent = ratio === null ? (job.status === "completed" ? 100 : 0) : Math.round(ratio * 100);
  const progress = job.progress;
  const valueText = progress
    ? t(`progress.${progressCountKey(job)}`, {
        done: integer(progress.done),
        total: integer(progress.total),
      })
    : t("progress.noProgress");

  return (
    <div className={cn("relative h-1.5", className)}>
      {/* The native element carries the semantics; the bars below are decoration. */}
      <progress
        className="sr-only"
        aria-label={t("progress.label")}
        aria-valuetext={valueText}
        max={100}
        value={indeterminate ? undefined : percent}
      />
      <div aria-hidden="true" className="h-full w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            BAR_TONE[job.status],
            indeterminate && "w-full animate-pulse opacity-40",
          )}
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Counts under the bar: items, new data, time left, failures, a Microsoft pause. */
export function ProgressSummary({ job, now }: { job: Job; now: number }) {
  const { t, integer, bytes, duration } = useJobFormat();
  const progress = job.progress;

  if (job.status === "queued") {
    return <p className="text-xs text-muted-foreground">{t("progress.waiting")}</p>;
  }
  if (!progress) {
    return <p className="text-xs text-muted-foreground">{t("progress.noProgress")}</p>;
  }

  const waiting = isWaitingForThrottle(job, now);
  const parts = [
    t(`progress.${progressCountKey(job)}`, {
      done: integer(progress.done),
      total: integer(progress.total),
    }),
    progress.bytes > 0
      ? t(`progress.${progressBytesKey(job)}`, { bytes: bytes(progress.bytes) })
      : null,
    job.status === "active" && !waiting && progress.etaSeconds !== null
      ? t("progress.eta", { duration: duration(progress.etaSeconds) })
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="space-y-0.5 text-xs">
      <p className="text-muted-foreground tabular-nums">{parts.join(" · ")}</p>
      {progress.failed > 0 ? (
        <p className="text-destructive">{t("progress.failed", { count: progress.failed })}</p>
      ) : null}
      <ThrottleWaitLine run={job} now={now} />
    </div>
  );
}

/**
 * "Paused by Microsoft, continuing in 20 s": the one-line form of a Graph
 * throttling wait for summaries and lists. Renders nothing while no wait is on.
 */
export function ThrottleWaitLine({
  run,
  now,
  className,
}: { run: ThrottledRun; now: number; className?: string }) {
  const { t, duration } = useJobFormat();
  if (!isWaitingForThrottle(run, now)) {
    return null;
  }
  return (
    <p
      className={cn(
        "inline-flex items-center gap-1 text-warning-foreground dark:text-warning",
        className,
      )}
    >
      <Hourglass className="size-3" aria-hidden="true" />
      {t("throttle.waitingShort", {
        remaining: duration(throttleRemainingMs(run.throttle, now) / 1000),
      })}
    </p>
  );
}

/**
 * The honest explanation of a Graph throttling wait on a job page (backup,
 * restore): a countdown while Microsoft makes the run pause, a summary once it
 * resumed.
 */
export function ThrottleNotice({ job, now }: { job: ThrottledRun; now: number }) {
  const { t, duration } = useJobFormat();
  const throttle = job.throttle;
  if (!throttle || job.status !== "active") {
    return null;
  }
  const waiting = isWaitingForThrottle(job, now);
  return (
    <Alert variant={waiting ? "warning" : "info"}>
      {waiting ? <Hourglass /> : <TriangleAlert />}
      <AlertTitle>{t("throttle.title")}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>
          {waiting
            ? t("throttle.waiting", {
                status: throttle.status,
                remaining: duration(throttleRemainingMs(throttle, now) / 1000),
              })
            : t("throttle.resumed")}
        </p>
        <p className="text-muted-foreground">
          {t("throttle.summary", {
            count: throttle.waits,
            duration: duration(throttle.totalWaitMs / 1000),
          })}
        </p>
        <p className="text-muted-foreground">{t("throttle.explanation")}</p>
      </AlertDescription>
    </Alert>
  );
}
