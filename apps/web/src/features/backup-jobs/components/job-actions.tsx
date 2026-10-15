import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";
import { toast } from "@/components/ui/sonner";

import type { BackupJob, RunBackupJobResult, SkipReason } from "../api.js";
import { useDeleteBackupJob, useRunBackupJob, useToggleBackupJob } from "../hooks.js";
import { describeScope, runOutcomeView } from "../presenters.js";
import { jobErrorKey } from "../problems.js";

/** From this many objects or machines on, deleting a job asks for its name. */
export const DELETE_NAME_CONFIRM_FROM = 20;

/** Why a backup was not queued, as the toast says it. */
const SKIP_REASONS: readonly SkipReason[] = [
  "already_queued",
  "excluded",
  "orphaned",
  "source_pending",
  "source_disabled",
  "revoked",
  "retired",
  "not_in_job",
];

/**
 * What a job's actions do and how they say so: running a job (or some of its
 * objects) now, switching a mail job off and on, deleting a job. Each ends in a
 * toast; pausing and deleting ask first, in a dialog the page renders from `dialogs`.
 * A machine job cannot be paused (the agent decides when to back up).
 */
export function useJobActions(options: { onDeleted?: (job: BackupJob) => void } = {}) {
  const { t } = useTranslation("backupjobs");
  const run = useRunBackupJob();
  const toggle = useToggleBackupJob();
  const remove = useDeleteBackupJob();
  const [pausing, setPausing] = React.useState<BackupJob | null>(null);
  const [deleting, setDeleting] = React.useState<BackupJob | null>(null);
  const onDeleted = options.onDeleted;

  const failed = React.useCallback(
    (error: unknown) => toast.error(t("toasts.failed"), { description: t(jobErrorKey(error)) }),
    [t],
  );

  const runNow = React.useCallback(
    (
      job: Pick<BackupJob, "id" | "kind" | "name">,
      targetIds?: string[],
      options: { force?: boolean } = {},
    ) => {
      run.mutate(
        {
          jobId: job.id,
          ...(targetIds ? { targetIds } : {}),
          ...(options.force && job.kind === "copy" ? { force: true } : {}),
        },
        {
          onSuccess: (result: RunBackupJobResult) => {
            const skipped = SKIP_REASONS.map((reason) => ({
              reason,
              count: result.skipped.filter((entry) => entry.reason === reason).length,
            }))
              .filter((entry) => entry.count > 0)
              .map((entry) => t(`run.skipped.${entry.reason}`, { count: entry.count }))
              .join(" ");
            const outcome = runOutcomeView(result);
            if (outcome === "queued") {
              // A machine only gets the request: it starts at the agent's next check-in.
              const note = job.kind === "endpoint" ? t("toasts.runQueuedNote.endpoint") : "";
              toast.success(
                t(`toasts.runQueued.${job.kind}`, { count: result.queued, name: job.name }),
                { description: [note, skipped].filter(Boolean).join(" ") || undefined },
              );
            } else if (outcome === "waiting") {
              toast.info(t("toasts.runWaiting.title"), {
                description: t(`toasts.runWaiting.${job.kind}`, { count: result.skipped.length }),
              });
            } else {
              toast.info(t("toasts.runNothing", { name: job.name }), {
                description: skipped || undefined,
              });
            }
          },
          onError: failed,
        },
      );
    },
    [run, t, failed],
  );

  const resume = React.useCallback(
    (job: BackupJob) => {
      toggle.mutate(
        { jobId: job.id, enabled: true },
        {
          onSuccess: () => toast.success(t("toasts.resumed", { name: job.name })),
          onError: failed,
        },
      );
    },
    [toggle, t, failed],
  );

  const dialogs = (
    <>
      <ConfirmDialog
        open={pausing !== null}
        onOpenChange={(open) => {
          if (!open) setPausing(null);
        }}
        title={t("pause.title", { name: pausing?.name ?? "" })}
        description={
          <p>{pausing ? t("pause.description", { count: pausing.scope.count }) : null}</p>
        }
        confirmLabel={t("pause.confirm")}
        onConfirm={async () => {
          if (!pausing) return;
          await toggle.mutateAsync({ jobId: pausing.id, enabled: false });
          toast.success(t("toasts.paused", { name: pausing.name }));
          setPausing(null);
        }}
      />
      <DeleteJobDialog
        job={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={async (job) => {
          await remove.mutateAsync(job.id);
          toast.success(t("toasts.deleted", { name: job.name }));
          setDeleting(null);
          onDeleted?.(job);
        }}
      />
    </>
  );

  return {
    runNow,
    resume,
    askPause: setPausing,
    askDelete: setDeleting,
    running: run.isPending,
    dialogs,
  };
}

/**
 * The question before a job is deleted: how many objects or machines it
 * covers and what becomes of them. A mail job's objects are no longer backed up on
 * a schedule until another job takes them; a machine goes back to the schedule `none`
 * (release 0.2.1: it is not backed up) and is listed as without backup.
 */
export function DeleteJobDialog({
  job,
  onCancel,
  onConfirm,
}: {
  job: BackupJob | null;
  onCancel: () => void;
  onConfirm: (job: BackupJob) => Promise<void>;
}) {
  const { t } = useTranslation("backupjobs");
  return (
    <ConfirmDialog
      open={job !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t("delete.title", { name: job?.name ?? "" })}
      description={
        job ? (
          <>
            <p>
              {job.scope.count === 0
                ? t("delete.empty")
                : t(`delete.impact.${job.kind}`, {
                    count: job.scope.count,
                    scope: describeScope(job.scope, job.kind, t, job.copy),
                  })}
            </p>
            <p data-slot="delete-restore-points">
              {job.kind === "mail"
                ? job.retention.policyName
                  ? t("delete.restorePoints.mail", { policy: job.retention.policyName })
                  : t("delete.restorePoints.mailDefault")
                : t("delete.restorePoints.endpoint")}
            </p>
            <p>{t("delete.after")}</p>
          </>
        ) : null
      }
      confirmLabel={t("delete.confirm")}
      destructive
      // A large job is typed by name: one click must not stop the backups of many objects.
      confirmationText={job && job.scope.count >= DELETE_NAME_CONFIRM_FROM ? job.name : undefined}
      onConfirm={async () => {
        if (job) {
          await onConfirm(job);
        }
      }}
    />
  );
}
