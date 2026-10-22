import { useMutation } from "@tanstack/react-query";
import { Ban, LoaderCircle, Play } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, DisabledReason } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { errorMessageKey } from "@/lib/api";
import { cn } from "@/lib/utils";

import { cancelEndpointBackup, type EndpointDetail, type EndpointSummary } from "../api.js";
import { useBackupNow, useRefreshEndpoint } from "../hooks.js";
import type { MachineStatus } from "../machine-status.js";
import { endpointName, isWithoutBackup, progressRatio } from "../presenters.js";

/**
 * The cells of the Inventory table (0.4.5) that must not move the row: one state badge with a
 * small slot beside it (the backup's percent while it runs, else how many more problems apply),
 * and one action button whose size never changes ("Back up now", "Stop backup", "Withdraw",
 * "Stopping…"). The full story is in the machine's detail panel.
 */

/** The size of the action button, whatever it says. */
export const MACHINE_ACTION_CLASS = "w-40 justify-start";

/** The width of the state badge; its label is cut with an ellipsis (the panel has all of it). */
export const MACHINE_STATUS_BADGE_CLASS = "max-w-40 min-w-0";

/** The slot beside the badge: a small bar while a backup runs, or how many more states apply. */
export const MACHINE_STATUS_SLOT_CLASS = "inline-flex w-16 shrink-0 items-center gap-1";

/** One state as a badge (the table's primary state, or one of the panel's list). */
export function MachineStatusBadge({
  status,
  className,
}: {
  status: MachineStatus;
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  return (
    <Badge
      variant={status.tone}
      data-slot="machine-status"
      data-status={status.key}
      className={cn("justify-start", className)}
    >
      <span className="truncate">{t(`machineStatus.${status.key}`)}</span>
    </Badge>
  );
}

/** The State cell: the primary state, and beside it the progress or "+N" more problems. */
export function MachineStatusCell({
  machine,
  statuses,
}: {
  machine: Pick<EndpointSummary, "latestRun" | "hostname" | "displayName">;
  statuses: readonly MachineStatus[];
}) {
  const { t } = useTranslation("endpoints");
  const primary = statuses[0] as MachineStatus;
  const more = statuses.slice(1).filter((status) => status.problem);
  const running = machine.latestRun?.status === "running" ? machine.latestRun : null;
  const ratio = running ? progressRatio(running.progress) : null;
  const percent = ratio === null ? null : Math.round(ratio * 100);
  return (
    <div className="flex min-w-0 items-center gap-2" data-slot="machine-state">
      <MachineStatusBadge status={primary} className={MACHINE_STATUS_BADGE_CLASS} />
      <span className={MACHINE_STATUS_SLOT_CLASS} data-slot="machine-state-slot">
        {running ? (
          percent === null ? (
            <span className="h-1.5 w-full animate-pulse rounded-full bg-info/30 motion-reduce:animate-none" />
          ) : (
            <>
              <span
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={t("sheet.progressOf", { name: endpointName(machine) })}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <span className="block h-full bg-info" style={{ width: `${percent}%` }} />
              </span>
              <span className="w-[4ch] text-right text-xs text-muted-foreground tabular-nums">
                {percent}%
              </span>
            </>
          )
        ) : more.length > 0 ? (
          <Badge variant="muted" className="px-1.5" data-slot="machine-more-states">
            +{more.length}
            <span className="sr-only">
              : {more.map((status) => t(`machineStatus.${status.key}`)).join(", ")}
            </span>
          </Badge>
        ) : null}
      </span>
    </div>
  );
}

/** What of a machine's backup can be stopped: the running one, else a waiting "back up now". */
export interface StoppableBackup {
  activity: "running" | "queued";
  cancelling: boolean;
  by: string | null;
}

/**
 * What can be stopped (0.4.2): the running backup, else a "back up now" that waits for the
 * machine. `cancelling` while the agent has not stopped it yet.
 */
export function stoppableBackup(
  detail: Pick<EndpointDetail, "runs" | "tasks">,
): StoppableBackup | null {
  const run = detail.runs.find((r) => r.kind === "backup" && r.status === "running");
  if (run) {
    return {
      activity: "running",
      cancelling: Boolean(run.cancelRequestedAt),
      by: run.cancelledBy ?? null,
    };
  }
  const queued = detail.tasks.filter(
    (task) =>
      task.kind === "backup_now" && (task.status === "pending" || task.status === "delivered"),
  );
  if (queued.length === 0) {
    return null;
  }
  return {
    activity: "queued",
    cancelling: queued.every((task) => Boolean(task.cancelRequestedAt)),
    by: queued[0]?.cancelledBy ?? null,
  };
}

/** What the table knows without the machine's detail: its running backup. */
export function runningBackupOf(
  machine: Pick<EndpointSummary, "status" | "latestRun">,
): StoppableBackup | null {
  const run = machine.latestRun;
  if (machine.status !== "active" || run?.kind !== "backup" || run.status !== "running") {
    return null;
  }
  return {
    activity: "running",
    cancelling: Boolean(run.cancelRequestedAt),
    by: run.cancelledBy ?? null,
  };
}

/** Stop the backup of any machine (the table's rows and the panel); refreshes it afterwards. */
export function useStopMachineBackup() {
  const refresh = useRefreshEndpoint();
  return useMutation({
    mutationFn: (endpointId: string) => cancelEndpointBackup(endpointId),
    onSettled: (_result, _error, endpointId) => refresh(endpointId),
  });
}

/**
 * The one action of a machine's row: "Back up now", or while a backup runs or waits "Stop
 * backup" / "Withdraw" (after a question), "Stopping…" once asked. Always the same size
 * (`MACHINE_ACTION_CLASS`), so the row does not move when the machine changes state.
 * `allowed` false (a role that may only look, the public demo): disabled with the reason.
 */
export function MachineActionButton({
  machine,
  stoppable,
  allowed,
  reason,
  className = MACHINE_ACTION_CLASS,
}: {
  machine: Pick<EndpointSummary, "id" | "status" | "job" | "hostname" | "displayName">;
  stoppable: StoppableBackup | null;
  allowed: boolean;
  /** Why the action is closed when `allowed` is false. */
  reason?: string;
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  const { t: tc } = useTranslation();
  const backup = useBackupNow();
  const stop = useStopMachineBackup();
  const [asking, setAsking] = React.useState(false);
  const name = endpointName(machine);
  if (stoppable?.cancelling) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled
        className={className}
        data-slot="machine-action"
        data-action="stopping"
      >
        <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
        <span className="truncate">{t("cancel.cancelling")}</span>
      </Button>
    );
  }
  if (stoppable) {
    const running = stoppable.activity === "running";
    return (
      <>
        <DisabledReason reason={allowed ? null : (reason ?? null)}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!allowed}
            className={className}
            onClick={() => setAsking(true)}
            data-slot="machine-action"
            data-action="stop"
            aria-label={`${running ? t("cancel.stop") : t("cancel.withdraw")}: ${name}`}
          >
            <Ban aria-hidden="true" />
            <span className="truncate">{running ? t("cancel.stop") : t("cancel.withdraw")}</span>
          </Button>
        </DisabledReason>
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          title={running ? t("cancel.stopTitle", { name }) : t("cancel.withdrawTitle", { name })}
          description={running ? t("cancel.stopBody") : t("cancel.withdrawBody")}
          confirmLabel={running ? t("cancel.stopConfirm") : t("cancel.withdrawConfirm")}
          cancelLabel={t("cancel.keep")}
          destructive
          pending={stop.isPending}
          error={stop.error ? tc(errorMessageKey(stop.error)) : undefined}
          onConfirm={() =>
            stop.mutateAsync(machine.id).then((result) => {
              setAsking(false);
              if (result.stopping > 0) {
                toast.success(t("cancel.stopping"), { description: t("cancel.stoppingNote") });
              } else {
                toast.success(t("cancel.withdrawn"));
              }
            })
          }
        />
      </>
    );
  }
  const revoked = machine.status === "revoked";
  const noJob = isWithoutBackup(machine);
  const closed = !allowed ? (reason ?? null) : null;
  const why = revoked
    ? t("list.rowActions.revoked")
    : noJob
      ? t("actions.backup.needsJob")
      : closed;
  return (
    <DisabledReason reason={why}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={why !== null}
        loading={backup.pending}
        className={className}
        onClick={() => backup.request(machine.id)}
        data-slot="machine-action"
        data-action="backup"
        aria-label={`${t("actions.backup.label")}: ${name}`}
      >
        {backup.pending ? null : <Play aria-hidden="true" />}
        <span className="truncate">{t("actions.backup.label")}</span>
      </Button>
    </DisabledReason>
  );
}
