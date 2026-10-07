import { Info, RotateCcw, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState, RelativeTime } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { FailureExplanation } from "@/features/failures";
import { cn } from "@/lib/utils";

import type { RunDetail, RunProgress } from "../api.js";
import { type EndpointFormat, useEndpointFormat, useRun } from "../hooks.js";
import {
  RUN_ERRORS_SHOWN,
  formatDuration,
  onlyInterrupted,
  progressRatio,
  runDurationMs,
  runErrorView,
  runKindKey,
} from "../presenters.js";
import { Fact, Facts } from "./facts.js";
import { RunStatusBadge } from "./status.js";

/** The live state of a running run: how far it is and which file it is on. */
export function RunProgressView({
  progress,
  format,
  compact = false,
}: { progress: RunProgress | null; format: EndpointFormat; compact?: boolean }) {
  const { t } = format;
  const ratio = progressRatio(progress);
  const percent = ratio === null ? null : Math.round(ratio * 100);
  return (
    <div className="space-y-2" data-slot="run-progress">
      {percent === null ? (
        // Without a total there is no percentage: a pulsing bar says "working", the text below says how far.
        <div
          aria-hidden="true"
          className="relative h-2 w-full overflow-hidden rounded-full bg-primary/20"
        >
          <div className="absolute inset-0 animate-pulse rounded-full bg-primary/40" />
        </div>
      ) : (
        <Progress value={percent} aria-label={t("runs.progress.label")} />
      )}
      {compact ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {percent === null
            ? progress
              ? t("runs.progress.files", { done: format.integer(progress.filesDone) })
              : t("runs.progress.none")
            : `${percent}%`}
        </p>
      ) : progress ? (
        <>
          <p className="text-sm tabular-nums">
            {progress.totalFiles !== undefined
              ? t("runs.progress.filesOf", {
                  done: format.integer(progress.filesDone),
                  total: format.integer(progress.totalFiles),
                })
              : t("runs.progress.files", { done: format.integer(progress.filesDone) })}
            {" · "}
            {progress.totalBytes !== undefined
              ? t("runs.progress.bytesOf", {
                  done: format.bytes(progress.bytesDone),
                  total: format.bytes(progress.totalBytes),
                })
              : format.bytes(progress.bytesDone)}
            {percent !== null ? ` · ${percent}%` : ""}
          </p>
          {progress.currentPath ? (
            <p
              className="truncate font-mono text-xs text-muted-foreground"
              title={progress.currentPath}
            >
              {progress.currentPath}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("runs.progress.updated")}{" "}
            <RelativeTime value={progress.updatedAt} focusable={false} />
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("runs.progress.none")}</p>
      )}
    </div>
  );
}

/**
 * Everything one run reported: facts, live progress, the files it could not
 * read, and the log tail. A restore test that could not complete is
 * explained in neutral words, never as a failure; `willRetry` is false on a
 * revoked machine, which runs no more tests.
 */
export function RunDetailView({
  run,
  subjectName,
  willRetry = true,
}: { run: RunDetail; subjectName?: string; willRetry?: boolean }) {
  const format = useEndpointFormat();
  const { t, language } = format;
  const duration = runDurationMs(run);
  const stats = run.stats;
  const shownErrors = run.errors.slice(0, RUN_ERRORS_SHOWN);
  const hiddenErrors = run.errors.length - shownErrors.length;
  const incomplete = run.checkIncomplete === true && run.status !== "running";
  const interrupted = onlyInterrupted(run.errors) && !incomplete;
  return (
    <div className="space-y-5 px-4 pb-6">
      <Facts>
        <Fact label={t("runs.facts.status")}>
          <RunStatusBadge
            status={run.status}
            kind={run.kind}
            interrupted={interrupted}
            checkIncomplete={incomplete}
            willRetry={willRetry}
          />
        </Fact>
        <Fact label={t("runs.facts.started")}>
          {format.dateTime(run.startedAt) ?? t("runs.unknown")}
        </Fact>
        <Fact label={t("runs.facts.finished")}>
          {run.finishedAt
            ? (format.dateTime(run.finishedAt) ?? t("runs.unknown"))
            : t("runs.facts.notFinished")}
        </Fact>
        <Fact label={t("runs.facts.duration")}>
          {duration === null ? t("runs.unknown") : formatDuration(duration, language)}
        </Fact>
        {run.snapshotId ? (
          <Fact label={t("runs.facts.snapshot")}>
            <code className="font-mono text-xs" title={run.snapshotId}>
              {run.snapshotId.slice(0, 8)}
            </code>
          </Fact>
        ) : null}
        {stats ? (
          <>
            {stats.totalFilesProcessed !== undefined ? (
              <Fact label={t("runs.facts.filesProcessed")}>
                {format.integer(stats.totalFilesProcessed)}
              </Fact>
            ) : null}
            {stats.totalBytesProcessed !== undefined ? (
              <Fact label={t("runs.facts.bytesProcessed")}>
                {format.bytes(stats.totalBytesProcessed)}
              </Fact>
            ) : null}
            {stats.filesNew !== undefined ? (
              <Fact label={t("runs.facts.filesNew")}>{format.integer(stats.filesNew)}</Fact>
            ) : null}
            {stats.filesChanged !== undefined ? (
              <Fact label={t("runs.facts.filesChanged")}>{format.integer(stats.filesChanged)}</Fact>
            ) : null}
            {stats.filesUnmodified !== undefined ? (
              <Fact label={t("runs.facts.filesUnmodified")}>
                {format.integer(stats.filesUnmodified)}
              </Fact>
            ) : null}
            {stats.dataAdded !== undefined ? (
              <Fact label={t("runs.facts.dataAdded")}>{format.bytes(stats.dataAdded)}</Fact>
            ) : null}
          </>
        ) : null}
      </Facts>

      {run.status === "running" ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("runs.progress.heading")}</h3>
          <RunProgressView progress={run.progress} format={format} />
        </section>
      ) : null}

      {interrupted && run.status !== "running" ? (
        <Alert variant="info" data-run-note="interrupted">
          <Info />
          <AlertDescription>
            <p>{t("runs.interruptedNote")}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {incomplete ? (
        <Alert variant="info" data-run-note="incomplete">
          <RotateCcw />
          <AlertDescription>
            <p>{t(willRetry ? "runs.incompleteNote" : "runs.incompleteNoteFinal")}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {run.failure && !interrupted ? (
        // Why a test could not complete is worth knowing (a full disk, no network), but it is no failure.
        <FailureExplanation
          failure={run.failure}
          subject={{
            kind: "job",
            queue: t(runKindKey(run.kind)),
            object: subjectName ?? null,
          }}
          tone={incomplete ? "info" : run.status === "partial" ? "warning" : undefined}
          hideWhat={incomplete}
        />
      ) : null}
      {run.status === "partial" && !interrupted && !incomplete && !run.failure ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>
            <p>{t("runs.partialNote")}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {run.status === "failed" && !interrupted && !incomplete && !run.failure ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>
            <p>{t("runs.failedNote")}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-2" data-slot="run-errors">
        <h3 className="text-sm font-medium">
          {t("runs.errors.heading", { count: run.errors.length })}
        </h3>
        {run.errors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {run.status === "running" ? t("runs.errors.noneYet") : t("runs.errors.none")}
          </p>
        ) : (
          <>
            <ul className="divide-y rounded-md border text-sm">
              {shownErrors.map((error, index) => {
                const view = runErrorView(error);
                return (
                  <li
                    key={`${index}-${error.path ?? ""}-${error.message}`}
                    className="space-y-1 p-2.5"
                    data-run-error={error.code ?? undefined}
                  >
                    {view.headline ? (
                      <p
                        className={cn(
                          "flex items-start gap-1.5 font-medium",
                          view.neutral && "text-info-text",
                        )}
                      >
                        {view.neutral ? (
                          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                        ) : null}
                        {t(view.headline.key, view.headline.values)}
                      </p>
                    ) : null}
                    {error.path ? (
                      <p className="font-mono text-xs break-all">{error.path}</p>
                    ) : null}
                    {error.message && view.headline ? (
                      // The meaning is above in the reader's language; the agent's own (English) text is a detail.
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none">
                          {t("runErrors.detail")}
                        </summary>
                        <p className="mt-1 break-words" lang="en">
                          {error.message}
                        </p>
                      </details>
                    ) : error.message ? (
                      <p className="text-xs break-words text-muted-foreground" lang="en">
                        {error.message}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {hiddenErrors > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("runs.errors.more", { count: hiddenErrors })}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="space-y-2" data-slot="run-log">
        <h3 className="text-sm font-medium">{t("runs.log.heading")}</h3>
        {run.logTail ? (
          <>
            <pre
              className="max-h-80 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed whitespace-pre"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable log must be reachable by keyboard
              tabIndex={0}
              aria-label={t("runs.log.heading")}
            >
              {run.logTail}
            </pre>
            <p className="text-xs text-muted-foreground">{t("runs.log.note")}</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {run.status === "running" ? t("runs.log.running") : t("runs.log.empty")}
          </p>
        )}
      </section>
    </div>
  );
}

/** A side sheet with one run; it follows the run while it is running. */
export function RunSheet({
  endpointId,
  endpointName,
  runId,
  onClose,
  willRetry = true,
}: {
  endpointId: string;
  /** The machine's name, for the sentence that says what failed. */
  endpointName: string;
  runId: string | null;
  onClose: () => void;
  /** False on a revoked machine: a restore test that could not complete is not repeated. */
  willRetry?: boolean;
}) {
  const { t } = useTranslation("endpoints");
  const run = useRun(endpointId, runId);
  return (
    <Sheet
      open={runId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{run.data ? t(runKindKey(run.data.kind)) : t("runs.sheet.title")}</SheetTitle>
          <SheetDescription>{t("runs.sheet.description")}</SheetDescription>
        </SheetHeader>
        {run.isError ? (
          <div className="px-4">
            <ErrorState
              title={t("runs.sheet.error")}
              error={run.error}
              onRetry={() => void run.refetch()}
              retrying={run.isFetching}
            />
          </div>
        ) : run.data ? (
          <RunDetailView run={run.data} subjectName={endpointName} willRetry={willRetry} />
        ) : (
          <div className="space-y-3 px-4" aria-hidden="true">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
