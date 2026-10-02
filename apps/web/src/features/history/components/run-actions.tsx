import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Ban, DatabaseBackup, ExternalLink, History, Pencil, RotateCcw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useJobsAccess } from "@/features/backup-jobs/components/access-note";
import { useJobActions } from "@/features/backup-jobs/components/job-actions";
import { jobDefinitionTo, linkProps } from "@/features/backup-jobs/paths";
import { createTask } from "@/features/endpoints/api";
import { endpointDetailTo } from "@/features/endpoints/paths";
import { jobDetailTo } from "@/features/jobs/paths";
import { useStartBackup } from "@/features/jobs/use-jobs";
import { errorMessageKey } from "@/lib/api";

import type { Run } from "../api";
import { useCancelRun, useRetryRun } from "../hooks";
import { useRunTitle } from "./run-parts";

/**
 * What can be done with a run, in the order of the drawer's footer: cancel it (a mail run that is
 * queued or running; an agent owns its own runs), edit its job, open it in History, run it
 * again. The controls follow the jobs' access rules: closed in the public demo and for a role
 * that may only look, with the reason in a tooltip, not an error after the click.
 */

/** What "Run now" does for a run, or null when there is nothing to run. */
export type RunNow =
  | { kind: "job"; job: { id: string; name: string } }
  | { kind: "mail"; objectId: string }
  | { kind: "machine"; endpointId: string };

export function runNowOf(run: Pick<Run, "job" | "kind" | "source" | "subject">): RunNow | null {
  if (run.job) {
    return { kind: "job", job: run.job };
  }
  if (run.kind !== "backup" || !run.subject) {
    return null;
  }
  return run.source === "mail"
    ? { kind: "mail", objectId: run.subject.id }
    : { kind: "machine", endpointId: run.subject.id };
}

/** Failed or cancelled mail runs of the queues a retry makes sense for (the server checks the rest). */
export function retryable(run: Pick<Run, "source" | "state" | "type">): boolean {
  return (
    run.source === "mail" &&
    (run.state === "failed" || run.state === "cancelled") &&
    (run.type === "backup" || run.type === "verify")
  );
}

export interface RunActionsProps {
  run: Run;
  /** The drawer offers "Open in History"; the run's own page does not. */
  where: "drawer" | "page";
  className?: string;
}

export function RunActions({ run, where, className }: RunActionsProps) {
  const { t } = useTranslation("history");
  const { t: tc } = useTranslation();
  const access = useJobsAccess();
  const title = useRunTitle();
  const cancel = useCancelRun();
  const retry = useRetryRun();
  const startBackup = useStartBackup();
  const machineBackup = useMutation({
    mutationFn: (endpointId: string) => createTask(endpointId, { kind: "backup_now" }),
  });
  const jobActions = useJobActions();
  const [confirming, setConfirming] = React.useState(false);

  const now = runNowOf(run);
  const kind = run.source === "mail" ? "mail" : "endpoint";
  const closedHint = access.closed
    ? { "aria-describedby": access.noteId, title: access.reason }
    : {};
  const failed = (error: unknown) =>
    toast.error(t("actions.failed"), { description: tc(errorMessageKey(error)) });

  const runNow = () => {
    if (!now) {
      return;
    }
    if (now.kind === "job") {
      jobActions.runNow({ id: now.job.id, kind, name: now.job.name });
    } else if (now.kind === "mail") {
      startBackup.mutate(
        { protectedObjectId: now.objectId, full: false },
        {
          onSuccess: (result) =>
            result.queued.length > 0
              ? toast.success(t("actions.queued"))
              : toast.info(t("actions.nothingQueued")),
          onError: failed,
        },
      );
    } else {
      machineBackup.mutate(now.endpointId, {
        onSuccess: () => toast.success(t("actions.queued")),
        onError: failed,
      });
    }
  };

  const running = run.state === "running" || run.state === "queued";
  const pending = startBackup.isPending || machineBackup.isPending;

  return (
    <div className={className} data-slot="run-actions">
      {run.cancellable ? (
        <>
          <Button
            variant="outline"
            disabled={access.closed}
            onClick={() => setConfirming(true)}
            {...closedHint}
          >
            <Ban aria-hidden="true" />
            {t("actions.cancel")}
          </Button>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t("actions.cancelTitle")}
            description={t("actions.cancelBody", { name: title(run) })}
            confirmLabel={t("actions.cancelConfirm")}
            cancelLabel={t("actions.cancelKeep")}
            destructive
            onConfirm={() =>
              cancel.mutateAsync(run.id).then(() => toast.success(t("actions.cancelled")))
            }
          />
        </>
      ) : null}
      {run.job ? (
        <Button variant="outline" asChild>
          <Link {...linkProps(jobDefinitionTo(run.job.id, kind, "settings"))}>
            <Pencil aria-hidden="true" />
            {t("actions.editJob")}
          </Link>
        </Button>
      ) : null}
      {where === "drawer" ? (
        <Button variant={running ? "default" : "outline"} asChild>
          <Link to={jobDetailTo(run.id)}>
            <History aria-hidden="true" />
            {t("actions.openInHistory")}
          </Link>
        </Button>
      ) : null}
      {where === "page" && retryable(run) ? (
        <Button
          variant="outline"
          disabled={access.closed}
          loading={retry.isPending}
          onClick={() =>
            retry.mutate(run.id, {
              onSuccess: (next) => toast.success(t("actions.retried", { id: next.id.slice(0, 8) })),
              onError: failed,
            })
          }
          {...closedHint}
        >
          <RotateCcw aria-hidden="true" />
          {t("actions.retry")}
        </Button>
      ) : null}
      {now && !running ? (
        <Button
          variant={where === "drawer" ? "default" : "outline"}
          disabled={access.closed}
          loading={pending}
          onClick={runNow}
          {...closedHint}
        >
          <DatabaseBackup aria-hidden="true" />
          {t("actions.runNow")}
        </Button>
      ) : null}
      {where === "page" && run.subject && run.source === "endpoint" ? (
        <Button variant="ghost" asChild>
          <Link to={endpointDetailTo(run.subject.id)}>
            <ExternalLink aria-hidden="true" />
            {t("actions.openMachine")}
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
