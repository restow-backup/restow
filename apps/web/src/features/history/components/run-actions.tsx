import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Ban, DatabaseBackup, ExternalLink, History, Pencil, RotateCcw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, DisabledReason } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useJobsAccess } from "@/features/backup-jobs/components/access-note";
import { useJobActions } from "@/features/backup-jobs/components/job-actions";
import { jobDefinitionTo, linkProps } from "@/features/backup-jobs/paths";
import { createTask } from "@/features/endpoints/api";
import { endpointDetailTo } from "@/features/endpoints/paths";
import { endpointErrorKey } from "@/features/endpoints/presenters";
import { jobDetailTo } from "@/features/jobs/paths";
import { useStartBackup } from "@/features/jobs/use-jobs";
import { ApiError, errorMessageKey } from "@/lib/api";

import type { Run } from "../api";
import { useCancelRun, useRetryRun } from "../hooks";
import { useRunTitle } from "./run-parts";

/**
 * What can be done with a run, in the order of the drawer's footer: cancel it (a mail run that is
 * queued or running; an agent owns its own runs), edit its job, open it in History, run it
 * again. The controls follow the jobs' access rules: closed in the public demo and for a role
 * that may only look, with the reason in a tooltip, not an error after the click.
 */

/**
 * What "Run now" does for a run, or null when there is nothing to run. A run of one object or
 * machine in a job backs up that one again (`target`), not the whole job; only a run without a
 * subject runs the job, and that asks first.
 */
export type RunNow =
  | { kind: "job"; job: { id: string; name: string }; target: { id: string; name: string } | null }
  | { kind: "mail"; objectId: string }
  | { kind: "machine"; endpointId: string };

export function runNowOf(run: Pick<Run, "job" | "kind" | "source" | "subject">): RunNow | null {
  if (run.job) {
    if (run.kind === "backup" && run.subject) {
      return { kind: "job", job: run.job, target: { id: run.subject.id, name: run.subject.name } };
    }
    return { kind: "job", job: run.job, target: null };
  }
  if (run.kind !== "backup" || !run.subject) {
    return null;
  }
  return run.source === "mail"
    ? { kind: "mail", objectId: run.subject.id }
    : { kind: "machine", endpointId: run.subject.id };
}

/** The problem type of a machine backup refused because the machine is in no backup job (0.2.1). */
const NO_JOB_PROBLEM = "urn:restow:problem:endpoint-no-job";

/** Whether a failed "Run now" was refused because the machine is in no backup job. */
export function isNoJobProblem(error: unknown): boolean {
  return error instanceof ApiError && error.problem?.type === NO_JOB_PROBLEM;
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
  const navigate = useNavigate();
  const [confirming, setConfirming] = React.useState(false);
  const [confirmingJob, setConfirmingJob] = React.useState(false);

  const now = runNowOf(run);
  const kind = run.source === "mail" ? "mail" : "endpoint";
  const closedHint = access.closed ? { "aria-describedby": access.noteId } : {};
  const failed = (error: unknown) =>
    toast.error(t("actions.failed"), { description: tc(errorMessageKey(error)) });

  const runJob = (job: { id: string; name: string }, targetIds?: string[]) =>
    jobActions.runNow({ id: job.id, kind, name: job.name }, targetIds);

  const runNow = () => {
    if (!now) {
      return;
    }
    if (now.kind === "job") {
      if (now.target) {
        runJob(now.job, [now.target.id]);
      } else {
        // The whole job: every object or machine in it. Ask first.
        setConfirmingJob(true);
      }
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
      const endpointId = now.endpointId;
      machineBackup.mutate(endpointId, {
        onSuccess: (result) =>
          result.alreadyQueued
            ? toast.info(t("actions.alreadyWaiting"))
            : toast.success(t("actions.machineQueued"), {
                description: t("actions.machineQueuedNote"),
              }),
        onError: (error) => {
          if (isNoJobProblem(error)) {
            // Since 0.2.1 a machine is backed up only in a backup job: say so and lead to it.
            toast.error(t("actions.noJob.title"), {
              description: t("actions.noJob.description"),
              action: {
                label: t("actions.noJob.open"),
                onClick: () => void navigate({ to: endpointDetailTo(endpointId) }),
              },
            });
            return;
          }
          toast.error(t("actions.failed"), { description: t(endpointErrorKey(error)) });
        },
      });
    }
  };

  const running = run.state === "running" || run.state === "queued";
  const pending = startBackup.isPending || machineBackup.isPending || jobActions.running;

  return (
    <div className={className} data-slot="run-actions">
      {run.cancellable ? (
        <>
          <DisabledReason reason={access.closed ? access.reason : null}>
            <Button
              variant="outline"
              disabled={access.closed}
              onClick={() => setConfirming(true)}
              {...closedHint}
            >
              <Ban aria-hidden="true" />
              {t("actions.cancel")}
            </Button>
          </DisabledReason>
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
        <DisabledReason reason={access.closed ? access.reason : null}>
          <Button
            variant="outline"
            disabled={access.closed}
            loading={retry.isPending}
            onClick={() =>
              retry.mutate(run.id, {
                onSuccess: (next) =>
                  toast.success(t("actions.retried"), {
                    action: {
                      label: t("actions.openRun"),
                      onClick: () => void navigate({ to: jobDetailTo(next.id) }),
                    },
                  }),
                onError: failed,
              })
            }
            {...closedHint}
          >
            <RotateCcw aria-hidden="true" />
            {t("actions.retry")}
          </Button>
        </DisabledReason>
      ) : null}
      {now && !running ? (
        <DisabledReason reason={access.closed ? access.reason : null}>
          <Button
            variant={where === "drawer" ? "default" : "outline"}
            disabled={access.closed}
            loading={pending}
            onClick={runNow}
            {...closedHint}
          >
            <DatabaseBackup aria-hidden="true" />
            {now.kind === "job" && now.target
              ? t("actions.runNowFor", { name: now.target.name })
              : now.kind === "job"
                ? t("actions.runJobNow")
                : t("actions.runNow")}
          </Button>
        </DisabledReason>
      ) : null}
      {now?.kind === "job" && !now.target ? (
        <ConfirmDialog
          open={confirmingJob}
          onOpenChange={setConfirmingJob}
          title={t("actions.runJobTitle", { name: now.job.name })}
          description={t("actions.runJobBody")}
          confirmLabel={t("actions.runJobConfirm")}
          onConfirm={() => {
            runJob(now.job);
            setConfirmingJob(false);
          }}
        />
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
