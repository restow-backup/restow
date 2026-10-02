import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";
import { toast } from "@/components/ui/sonner";

import type { BackupJob, RunBackupJobResult, SkipReason } from "../api.js";
import { useDeleteBackupJob, useRunBackupJob, useToggleBackupJob } from "../hooks.js";
import { describeScope } from "../presenters.js";
import { jobErrorKey } from "../problems.js";

/** Why a backup was not queued, as the toast says it. */
const SKIP_REASONS: readonly SkipReason[] = [
  "already_queued",
  "excluded",
  "orphaned",
  "source_pending",
  "source_disabled",
  "revoked",
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
    (job: Pick<BackupJob, "id" | "kind" | "name">, targetIds?: string[]) => {
      run.mutate(
        { jobId: job.id, ...(targetIds ? { targetIds } : {}) },
        {
          onSuccess: (result: RunBackupJobResult) => {
            const skipped = SKIP_REASONS.map((reason) => ({
              reason,
              count: result.skipped.filter((entry) => entry.reason === reason).length,
            }))
              .filter((entry) => entry.count > 0)
              .map((entry) => t(`run.skipped.${entry.reason}`, { count: entry.count }))
              .join(" ");
            if (result.queued > 0) {
              toast.success(
                t(`toasts.runQueued.${job.kind}`, { count: result.queued, name: job.name }),
                {
                  description: skipped || undefined,
                },
              );
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
 * a schedule until another job takes them; a machine keeps the configuration it has
 * and is listed as not in a job.
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
                    scope: describeScope(job.scope, job.kind, t),
                  })}
            </p>
            <p>{t("delete.after")}</p>
          </>
        ) : null
      }
      confirmLabel={t("delete.confirm")}
      destructive
      onConfirm={async () => {
        if (job) {
          await onConfirm(job);
        }
      }}
    />
  );
}
