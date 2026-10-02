import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import { mergeRun, useRunDetail, useRunDrawer } from "../hooks";
import { useLiveRun } from "../live/provider";
import { RunActions } from "./run-actions";
import { RunStateBadge, SubjectIcon, useRunTitle } from "./run-parts";
import { RunView } from "./run-view";

/**
 * The run drawer: a wide panel from the right (full screen on a phone) with everything about
 * one run, live while it runs. Esc closes it, focus moves into it and returns to where it was,
 * and the address says which run is open (`?run=<id>`), so a link opens it.
 *
 * Opened from a row of the job list (the job's current or last run) or of History. The numbers
 * of a running run come from the live channel, the parts only the server derives (the objects of
 * its wave, the timeline, the restore check) from the run's detail.
 */

export interface RunDrawerProps {
  /** The run to show; null keeps the drawer closed. */
  runId: string | null;
  onClose: () => void;
  /** Move to another run of the wave without leaving the drawer. */
  onSwitch?: (runId: string) => void;
}

export function RunDrawer({ runId, onClose, onSwitch }: RunDrawerProps) {
  const { t, i18n } = useTranslation("history");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const title = useRunTitle();
  const detail = useRunDetail(runId);
  const live = useLiveRun(runId);
  const run = mergeRun(detail.data, live);
  const missing = detail.error instanceof ApiError && detail.error.status === 404 && !live;

  const scope = run
    ? [
        run.job?.name,
        t(`trigger.${run.trigger}`),
        run.attempt ? t("attempt", { number: run.attempt.number, of: run.attempt.of }) : null,
        run.startedAt
          ? t(run.state === "running" ? "drawer.since" : "drawer.started", {
              time: formatDateTime(run.startedAt, language) ?? "",
            })
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ")
    : "";

  return (
    <Sheet open={runId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        hideClose
        data-slot="run-drawer"
        className="w-full gap-0 p-0 motion-reduce:animate-none motion-reduce:transition-none sm:w-[min(780px,96vw)] sm:max-w-none"
      >
        <div className="flex items-start gap-3 border-b border-border p-4">
          {run?.subject ? (
            <SubjectIcon kind={run.subject.kind} className="mt-1 size-5 text-muted-foreground" />
          ) : null}
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-[15.5px]">
              {run ? title(run) : t("drawer.title")}
            </SheetTitle>
            <SheetDescription className="truncate text-xs">
              {scope || t("drawer.loading")}
            </SheetDescription>
          </div>
          {run ? <RunStateBadge run={run} className="mt-0.5" /> : null}
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className="-mt-1 -mr-1 shrink-0">
              <X aria-hidden="true" />
              <span className="sr-only">{t("drawer.close")}</span>
            </Button>
          </SheetClose>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {missing ? (
            <Alert variant="warning">
              <AlertDescription>{t("drawer.notFound")}</AlertDescription>
            </Alert>
          ) : run ? (
            <RunView
              run={run}
              detail={detail.data}
              loading={detail.isPending}
              error={detail.error}
              onRetry={() => void detail.refetch()}
              onOpenRun={onSwitch}
            />
          ) : detail.isError ? (
            <ErrorState
              title={t("view.loadError")}
              error={detail.error}
              onRetry={() => void detail.refetch()}
              retrying={detail.isFetching}
            />
          ) : (
            <div className="space-y-4" aria-busy="true">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
        </div>

        {run ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-3">
            <RunActions run={run} where="drawer" className="contents" />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** The drawer of the page it sits on, driven by `?run=` in the address. Put it once on a page. */
export function RunDrawerHost() {
  const drawer = useRunDrawer();
  return <RunDrawer runId={drawer.runId} onClose={drawer.close} onSwitch={drawer.replaceWith} />;
}
