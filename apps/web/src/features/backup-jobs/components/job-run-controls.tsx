import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, LoaderCircle, Play } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, DisabledReason } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useTenantScope } from "@/features/endpoints/hooks";
import type { Run } from "@/features/history/api";
import { useLiveRuns } from "@/features/history/live/provider";
import { cancelGuestBackup, cancelPveJob, pveKeys, runPveJob } from "@/features/pve/api";
import { ApiError, errorMessageKey } from "@/lib/api";
import { cn } from "@/lib/utils";

import type { BackupJob } from "../api.js";
import { useCancelBackupJob } from "../hooks.js";
import type { JobsAccess } from "./access-note.js";
import { useRunNow } from "./job-actions.js";
import { isPveRow, type JobsListRow } from "./pve-rows.js";

/**
 * "Start now" and "Stop" of the jobs (0.4.5): on every row of the job lists (Servers & clients
 * and Mail & SaaS), in the row's "…" menu and in the job's detail panel, for each kind of job
 * the server can start and stop as a whole:
 *
 *   mail, endpoint,   POST /backup-jobs/:id/run and /cancel (a mail backup stops at its next
 *   share, copy       halt point, a machine's with its agent's next contact, a share's run
 *                     through its runner)
 *   Proxmox VE        POST /pve/jobs/:id/run and /cancel (every guest the job covers)
 *   a manual guest    POST /pve/guests/:id/cancel (it was started by hand: stop only)
 *   backup
 *
 * What runs comes from the live channel (the job's runs that wait or run), the job's own
 * counts and, for Proxmox VE, the job's round. "Stop" asks first; once asked the button says
 * "Stopping…" until nothing of the job runs any more. The button keeps one size whatever it
 * says (`JOB_ACTION_CLASS`), so the row never moves.
 */

/** The size of a row's action button, whatever it says. */
export const JOB_ACTION_CLASS = "w-36 justify-start";

/** How long a "Stopping…" holds when the job's state does not say it ended (a slow refresh). */
const STOPPING_HOLD_MS = 10 * 60_000;

export interface JobActivity {
  /** Backups of the job that run now. */
  running: number;
  /** Backups of the job that wait. */
  queued: number;
  /** Every running or waiting backup was asked to stop already. */
  cancelling: boolean;
  /** The progress of the job's backups in percent while they run; null when unknown. */
  percent: number | null;
  /** The live run the job's progress is shown by (the one that started first). */
  lead: Run | null;
}

const IDLE: JobActivity = { running: 0, queued: 0, cancelling: false, percent: null, lead: null };

/** What a job of the list does right now. */
export function jobActivity(
  row: JobsListRow,
  liveRuns: Readonly<Record<string, Run>>,
): JobActivity {
  if (isPveRow(row)) {
    if (row.rowType === "manual") {
      const guest = row.guest;
      return {
        running: guest.activity === "running" ? 1 : 0,
        queued: guest.activity === "queued" ? 1 : 0,
        cancelling: Boolean(guest.cancelling),
        percent: null,
        lead: null,
      };
    }
    const round = row.job.round;
    if (!round) {
      return IDLE;
    }
    return {
      running: round.running,
      queued: round.queued,
      cancelling: false,
      percent: round.total > 0 ? Math.round((round.done / round.total) * 100) : null,
      lead: null,
    };
  }
  const own = Object.values(liveRuns).filter(
    (run) =>
      run.job?.id === row.id &&
      run.kind === "backup" &&
      (run.state === "running" || run.state === "queued"),
  );
  const liveRunning = own.filter((run) => run.state === "running");
  const lead =
    [...liveRunning].sort(
      (a, b) => Date.parse(a.startedAt ?? a.createdAt) - Date.parse(b.startedAt ?? b.createdAt),
    )[0] ?? null;
  const running = Math.max(liveRunning.length, row.lastRun.running);
  const queued = Math.max(own.length - liveRunning.length, row.lastRun.queued);
  return {
    running: running === 0 && row.state === "running" ? 1 : running,
    queued: queued === 0 && running === 0 && row.state === "queued" ? 1 : queued,
    cancelling: own.length > 0 && own.every((run) => run.cancelling === true),
    percent: lead?.progress?.percent ?? null,
    lead,
  };
}

/** The activity of every row, from the live channel. */
export function useJobActivity(row: JobsListRow): JobActivity {
  const liveRuns = useLiveRuns();
  return React.useMemo(() => jobActivity(row, liveRuns), [row, liveRuns]);
}

export function isActive(activity: JobActivity): boolean {
  return activity.running + activity.queued > 0;
}

/** The id the controls know a row by (the row's own: a job's id, `pve:`/`pve-guest:` ones). */
function rowKey(row: JobsListRow): string {
  return row.id;
}

/** What a row's start and stop do, and their dialog; one per page (see `useJobRunControls`). */
export interface JobRunControls {
  /** Start the job now; nothing for a manual guest backup (it was started by hand). */
  start: (row: JobsListRow) => void;
  /** Ask whether to stop the job's backups; stops after the answer. */
  askStop: (row: JobsListRow) => void;
  /** A start of this row is on its way. */
  starting: (row: JobsListRow) => boolean;
  /** A stop of this row was sent and its backups have not ended yet. */
  stopRequested: (row: JobsListRow) => boolean;
  /** The question before a stop: render it once on the page. */
  dialog: React.ReactNode;
}

function canStart(row: JobsListRow): boolean {
  if (isPveRow(row)) {
    return row.rowType === "pve" && row.job.enabled !== false;
  }
  return row.scope.count > 0;
}

/**
 * Start and stop of the jobs of a page, with their toasts and the one question before a stop.
 * Pending starts and sent stops are kept per row, so other rows stay usable.
 */
export function useJobRunControls(): JobRunControls {
  const { t } = useTranslation("backupjobs");
  const { t: tc } = useTranslation();
  const queryClient = useQueryClient();
  const { tenantId } = useTenantScope();
  const { runNow } = useRunNow();
  const cancelJob = useCancelBackupJob();
  const [starting, setStarting] = React.useState<ReadonlySet<string>>(new Set());
  const [stopped, setStopped] = React.useState<ReadonlyMap<string, number>>(new Map());
  const [asking, setAsking] = React.useState<JobsListRow | null>(null);
  const refreshPve = React.useCallback(
    () => void queryClient.invalidateQueries({ queryKey: pveKeys.all(tenantId) }),
    [queryClient, tenantId],
  );
  const pveRun = useMutation({ mutationFn: (jobId: string) => runPveJob(jobId) });
  const pveCancel = useMutation({
    mutationFn: (row: JobsListRow) => {
      if (isPveRow(row)) {
        return row.rowType === "pve" ? cancelPveJob(row.job.id) : cancelGuestBackup(row.guest.id);
      }
      return Promise.reject(new Error("not a Proxmox VE row"));
    },
  });

  const mark = React.useCallback(
    (key: string, on: boolean) =>
      setStarting((current) => {
        const next = new Set(current);
        if (on) next.add(key);
        else next.delete(key);
        return next;
      }),
    [],
  );

  const start = React.useCallback(
    (row: JobsListRow) => {
      if (!canStart(row)) return;
      const key = rowKey(row);
      if (!isPveRow(row)) {
        runNow(row as BackupJob);
        return;
      }
      if (row.rowType !== "pve") return;
      mark(key, true);
      pveRun.mutate(row.job.id, {
        onSuccess: (result) => {
          const skipped = [
            result.alreadyQueued > 0
              ? t("run.pve.alreadyQueued", { count: result.alreadyQueued })
              : null,
            result.noNode > 0 ? t("run.pve.noNode", { count: result.noNode }) : null,
            result.selfBackup > 0 ? t("run.pve.selfBackup", { count: result.selfBackup }) : null,
          ]
            .filter(Boolean)
            .join(" ");
          if (result.queued > 0) {
            toast.success(t("run.pve.queued", { count: result.queued, name: row.job.name }), {
              description: skipped || undefined,
            });
          } else {
            toast.info(t("toasts.runNothing", { name: row.job.name }), {
              description: skipped || undefined,
            });
          }
        },
        onError: (error) =>
          toast.error(t("toasts.failed"), { description: tc(errorMessageKey(error)) }),
        onSettled: () => {
          mark(key, false);
          refreshPve();
        },
      });
    },
    [runNow, pveRun, t, tc, refreshPve, mark],
  );

  const stop = async (row: JobsListRow) => {
    try {
      const result = isPveRow(row)
        ? await pveCancel.mutateAsync(row)
        : await cancelJob.mutateAsync(row.id);
      setStopped((current) => new Map(current).set(rowKey(row), Date.now()));
      const description = [
        result.withdrawn > 0 ? t("stop.withdrawn", { count: result.withdrawn }) : null,
        result.stopping > 0 ? t("stop.stoppingCount", { count: result.stopping }) : null,
        result.stopping > 0 ? t(`stop.doneNote.${stopKind(row)}`) : null,
      ]
        .filter(Boolean)
        .join(" ");
      toast.success(t("stop.done", { name: row.name }), { description: description || undefined });
      setAsking(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Everything ended in the meantime: nothing is left to stop.
        toast.info(t("stop.nothing"));
        setAsking(null);
      } else {
        throw error;
      }
    } finally {
      if (isPveRow(row)) refreshPve();
    }
  };

  const stopping = cancelJob.isPending || pveCancel.isPending;
  const name = asking?.name ?? "";
  const dialog = (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(open) => {
        if (!open) {
          setAsking(null);
          cancelJob.reset();
          pveCancel.reset();
        }
      }}
      title={t("stop.title", { name })}
      description={asking ? t(`stop.body.${stopKind(asking)}`) : null}
      confirmLabel={t("stop.confirm")}
      cancelLabel={t("stop.keep")}
      destructive
      pending={stopping}
      onConfirm={() => (asking ? stop(asking) : undefined)}
    />
  );

  return {
    start,
    askStop: setAsking,
    starting: (row) => starting.has(rowKey(row)),
    stopRequested: (row) => {
      const at = stopped.get(rowKey(row));
      return at !== undefined && Date.now() - at < STOPPING_HOLD_MS;
    },
    dialog,
  };
}

/** Which explanation a stop gets: what stopping means differs by kind. */
function stopKind(row: JobsListRow): "mail" | "endpoint" | "share" | "pve" | "guest" {
  if (isPveRow(row)) {
    return row.rowType === "pve" ? "pve" : "guest";
  }
  if (row.kind === "mail") return "mail";
  if (row.kind === "endpoint") return "endpoint";
  return "share";
}

/**
 * The one action of a job's row: "Start now", or while the job's backups run or wait "Stop"
 * (after a question), "Stopping…" once asked. Always the same size.
 */
export function JobRunButton({
  row,
  controls,
  access,
  className = JOB_ACTION_CLASS,
  variant = "outline",
}: {
  row: JobsListRow;
  controls: JobRunControls;
  access: JobsAccess;
  className?: string;
  variant?: "outline" | "default";
}) {
  const { t } = useTranslation("backupjobs");
  const activity = useJobActivity(row);
  const active = isActive(activity);
  const closed = access.closed;
  if (active && (activity.cancelling || controls.stopRequested(row))) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled
        className={className}
        data-slot="job-action"
        data-action="stopping"
      >
        <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
        <span className="truncate">{t("stop.stopping")}</span>
      </Button>
    );
  }
  if (active) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={closed}
        className={className}
        onClick={() => controls.askStop(row)}
        data-slot="job-action"
        data-action="stop"
        aria-label={`${t("stop.action")}: ${row.name}`}
        aria-describedby={closed ? access.noteId : undefined}
      >
        <Ban aria-hidden="true" />
        <span className="truncate">{t("stop.action")}</span>
      </Button>
    );
  }
  const startable = canStart(row);
  if (isPveRow(row) && row.rowType === "manual") {
    // A backup started by hand that ended: nothing to start from here; the slot stays.
    return <span className={cn("inline-block", className)} aria-hidden="true" />;
  }
  const starting = controls.starting(row);
  return (
    <DisabledReason reason={closed ? null : startable ? null : t("run.emptyScope")}>
      <Button
        type="button"
        size="sm"
        variant={variant}
        disabled={closed || !startable}
        loading={starting}
        className={className}
        onClick={() => controls.start(row)}
        data-slot="job-action"
        data-action="start"
        aria-label={`${t("actions.runNow")}: ${row.name}`}
        aria-describedby={closed ? access.noteId : undefined}
      >
        {starting ? null : <Play aria-hidden="true" />}
        <span className="truncate">{t("actions.runNow")}</span>
      </Button>
    </DisabledReason>
  );
}
