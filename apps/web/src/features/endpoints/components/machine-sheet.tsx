import { Link } from "@tanstack/react-router";
import { ExternalLink, FolderSearch } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DetailFact, DetailSection, DetailSheet, LogBlock, RelativeTime } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CauseLine } from "@/features/failures/cause-line";
import { cn } from "@/lib/utils";

import type { EndpointDetail, EndpointSummary, RunSummary } from "../api.js";
import { useEndpoint, useEndpointFormat, useRun } from "../hooks.js";
import { machineStatuses } from "../machine-status.js";
import { endpointDetailTo, fileRestoreTo } from "../paths.js";
import { assigneeName, endpointHostLine, endpointName } from "../presenters.js";
import {
  MachineActionButton,
  MachineStatusBadge,
  runningBackupOf,
  stoppableBackup,
} from "./machine-cells.js";
import { RunProgressView } from "./run-sheet.js";
import { OsLabel, RunStatusBadge } from "./status.js";

/**
 * The detail panel of a machine on Inventory (0.4.5), like the guests' of 0.4.3: everything the
 * table row leaves out, so the row can stay one line. Opened by clicking the row, its name or its
 * state (`?machine=<id>`, so a link opens it), closed with Esc or the close button; focus goes
 * back to the machine's name in the table. It lists every state, the full error and warning
 * texts of the newest backup (monospace, scrollable, copyable), the restore check, the key
 * facts, the newest runs and the actions.
 */

/** How many of the newest runs the panel lists. */
export const MACHINE_SHEET_RUNS = 5;

/** The data attribute of a row's name button: where focus returns when the panel closes. */
export const MACHINE_NAME_ATTRIBUTE = "data-machine-name";

export interface MachineSheetProps {
  /** The machine of the open panel; null keeps it closed. */
  machineId: string | null;
  /** The machine as the list has it (refreshes with it); null while not found. */
  machine: EndpointSummary | null;
  loading?: boolean;
  onClose: () => void;
  /** The viewer may back up and stop (a job admin, not the public demo). */
  allowed: boolean;
  reason?: string;
}

function errorText(run: { errors: readonly { path?: string; message: string }[] }): string {
  return run.errors
    .map((error) => (error.path ? `${error.path}: ${error.message}` : error.message))
    .join("\n");
}

/** The errors of one run (fetched with the run), as a copyable block. */
function RunErrors({
  machineId,
  run,
  tone,
}: {
  machineId: string;
  run: RunSummary;
  tone: "destructive" | "warning";
}) {
  const { t } = useTranslation("endpoints");
  const detail = useRun(machineId, run.id);
  if (detail.isPending) {
    return <Skeleton className="h-16 w-full" />;
  }
  const text = detail.data ? errorText(detail.data) : "";
  return (
    <div className="space-y-2">
      {run.failure ? <CauseLine failure={run.failure} className="text-sm" /> : null}
      {text ? (
        <LogBlock
          text={text}
          tone={tone}
          label={tone === "destructive" ? t("sheet.copyError") : t("sheet.copyWarnings")}
          name={tone === "destructive" ? t("sheet.lastError") : t("sheet.warnings")}
          data-slot={tone === "destructive" ? "machine-error" : "machine-warnings"}
        />
      ) : null}
      {detail.data?.logTail ? (
        <p className="text-xs text-muted-foreground">{t("sheet.logTail")}</p>
      ) : null}
      {detail.data?.logTail ? (
        <LogBlock
          text={detail.data.logTail}
          label={t("sheet.copyLog")}
          name={t("sheet.logTail")}
          data-slot="machine-log"
        />
      ) : null}
    </div>
  );
}

function RecentRuns({ runs }: { runs: readonly RunSummary[] }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("sheet.noRuns")}</p>;
  }
  return (
    <ol className="space-y-3" data-slot="machine-sheet-runs">
      {runs.map((run) => (
        <li key={run.id} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{t(`runKind.${run.kind}`)}</span>
            <RunStatusBadge
              status={run.status}
              kind={run.kind}
              interrupted={run.interruptedOnly}
              checkIncomplete={run.checkIncomplete}
            />
            <span className="text-muted-foreground tabular-nums">
              {format.dateTime(run.startedAt)}
            </span>
          </div>
          {run.failure ? <CauseLine failure={run.failure} /> : null}
        </li>
      ))}
    </ol>
  );
}

export function MachineSheet({
  machineId,
  machine,
  loading = false,
  onClose,
  allowed,
  reason,
}: MachineSheetProps) {
  const { t } = useTranslation("endpoints");
  const detailQuery = useEndpoint(machineId ?? "", machineId !== null);
  const detail: EndpointDetail | undefined =
    detailQuery.data && detailQuery.data.id === machineId ? detailQuery.data : undefined;
  // The list refreshes with the live channel; the detail adds runs, requests and problems.
  const current = machine ?? detail ?? null;
  const name = current ? endpointName(current) : t("sheet.title");
  const description = current
    ? [endpointHostLine(current), t(`profile.${current.profile}`), current.job?.name]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <DetailSheet
      open={machineId !== null}
      onClose={onClose}
      title={name}
      description={description}
      loading={!current && (loading || detailQuery.isPending)}
      notFound={!current ? t("sheet.notFound") : undefined}
      returnFocus={() =>
        machineId
          ? document.querySelector<HTMLElement>(
              `[${MACHINE_NAME_ATTRIBUTE}="${CSS.escape(machineId)}"]`,
            )
          : null
      }
      slot="machine-sheet"
    >
      {current ? (
        <MachineSheetBody
          machine={current}
          detail={detail}
          detailPending={detailQuery.isPending}
          allowed={allowed}
          reason={reason}
        />
      ) : null}
    </DetailSheet>
  );
}

function MachineSheetBody({
  machine,
  detail,
  detailPending,
  allowed,
  reason,
}: {
  machine: EndpointSummary;
  detail: EndpointDetail | undefined;
  detailPending: boolean;
  allowed: boolean;
  reason?: string;
}) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const statuses = machineStatuses(machine);
  const stoppable = detail ? stoppableBackup(detail) : runningBackupOf(machine);
  const runs = (detail?.runs ?? []).slice(0, MACHINE_SHEET_RUNS);
  const lastBackup = (detail?.runs ?? []).find(
    (run) => run.kind === "backup" && run.status !== "running",
  );
  const running = machine.latestRun?.status === "running" ? machine.latestRun : null;
  const readiness = machine.readiness;
  const noRestorePoint = readiness.latestSnapshotId === null;
  return (
    <>
      <DetailSection title={t("sheet.state")} slot="machine-sheet-state">
        <div className="flex flex-wrap gap-1.5" data-slot="machine-states">
          {statuses.map((status) => (
            <MachineStatusBadge key={status.key} status={status} />
          ))}
        </div>
        {running ? (
          <div className="space-y-1">
            <p className="text-sm">{t(`activity.${running.kind}`)}</p>
            <RunProgressView progress={running.progress} format={format} />
          </div>
        ) : null}
        {stoppable?.cancelling && stoppable.by ? (
          <p className="text-sm text-muted-foreground">
            {t("cancel.requestedBy", { name: stoppable.by })}
          </p>
        ) : null}
      </DetailSection>

      <div className="flex flex-wrap gap-2" data-slot="machine-sheet-actions">
        <MachineActionButton
          machine={machine}
          stoppable={stoppable}
          allowed={allowed}
          reason={reason}
          className="justify-start"
        />
        {noRestorePoint ? null : (
          <Link
            {...fileRestoreTo(machine.id)}
            search={fileRestoreTo(machine.id).search as never}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <FolderSearch aria-hidden="true" />
            {t("list.rowActions.restoreFiles")}
          </Link>
        )}
        <Link
          to={endpointDetailTo(machine.id)}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          data-slot="machine-sheet-open"
        >
          <ExternalLink aria-hidden="true" />
          {t("sheet.openPage")}
        </Link>
      </div>

      {lastBackup && (lastBackup.status === "failed" || lastBackup.status === "partial") ? (
        <DetailSection
          title={lastBackup.status === "failed" ? t("sheet.lastError") : t("sheet.warnings")}
          slot="machine-sheet-error"
        >
          <p className="text-xs text-muted-foreground">
            {format.dateTime(lastBackup.finishedAt ?? lastBackup.startedAt)}
          </p>
          <RunErrors
            machineId={machine.id}
            run={lastBackup}
            tone={
              lastBackup.status === "failed" && !lastBackup.interruptedOnly
                ? "destructive"
                : "warning"
            }
          />
        </DetailSection>
      ) : null}

      {detail && detail.problems.length > 0 ? (
        <DetailSection title={t("sheet.problems")} slot="machine-sheet-problems">
          <ul className="space-y-1.5">
            {detail.problems.map((problem) => (
              <li key={problem.attention} className="text-sm">
                <span className="font-medium">{t(`attention.${problem.attention}.label`)}</span>
                <span className="text-muted-foreground">
                  {" "}
                  {t(`attention.${problem.attention}.hint`)}
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}

      <DetailSection title={t("sheet.restoreCheck")} slot="machine-sheet-verify">
        <dl className="space-y-1.5">
          <DetailFact label={t("sheet.result")}>
            {t(`readiness.state.${readiness.state}`)}
            {readiness.overdue && readiness.state !== "no_backup"
              ? ` · ${t("readiness.overdue")}`
              : ""}
          </DetailFact>
          {readiness.checkedAt ? (
            <DetailFact label={t("sheet.checkedAt")}>
              <RelativeTime value={readiness.checkedAt} />
            </DetailFact>
          ) : null}
          {readiness.basis ? (
            <DetailFact label={t("sheet.basis")}>
              {t(`sheet.basisKind.${readiness.basis}`)}
            </DetailFact>
          ) : null}
        </dl>
        {machine.job === null && readiness.state !== "no_backup" ? (
          <p className="text-sm text-muted-foreground">{t("readiness.frozenHint")}</p>
        ) : null}
      </DetailSection>

      <DetailSection title={t("sheet.facts")} slot="machine-sheet-facts">
        <dl className="space-y-1.5">
          <DetailFact label={t("list.columns.status")}>{t(connectionKey(machine))}</DetailFact>
          <DetailFact label={t("list.columns.lastSeen")}>
            <RelativeTime value={machine.lastSeenAt} fallback={t("status.never")} />
          </DetailFact>
          <DetailFact label={t("list.columns.lastBackup")}>
            <RelativeTime value={machine.lastBackupAt} fallback={t("list.noBackupYet")} />
          </DetailFact>
          <DetailFact label={t("sheet.lastSuccess")}>
            <RelativeTime value={machine.lastSuccessAt} fallback={t("list.noBackupYet")} />
          </DetailFact>
          {machine.nextRunAt ? (
            <DetailFact label={t("sheet.nextRun")}>
              <RelativeTime value={machine.nextRunAt} />
            </DetailFact>
          ) : null}
          <DetailFact label={t("list.columns.job")}>
            {machine.job ? machine.job.name : t("machineStatus.no_job")}
          </DetailFact>
          <DetailFact label={t("list.columns.assignedTo")}>
            {machine.assignedTo ? assigneeName(machine.assignedTo) : t("list.assignedNobody")}
          </DetailFact>
          <DetailFact label={t("list.columns.system")}>
            <OsLabel os={machine.os} arch={machine.arch} />
            {machine.osVersion ? (
              <span className="block text-xs text-muted-foreground">{machine.osVersion}</span>
            ) : null}
          </DetailFact>
          <DetailFact label={t("list.columns.agentVersion")}>
            <span className={cn(machine.agentVersion && "font-mono text-xs")}>
              {machine.agentVersion ?? t("list.unknown")}
            </span>
          </DetailFact>
        </dl>
      </DetailSection>

      <DetailSection title={t("sheet.runs")}>
        {detailPending && !detail ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <RecentRuns runs={runs} />
        )}
      </DetailSection>
    </>
  );
}

function connectionKey(machine: Pick<EndpointSummary, "status" | "connection">): string {
  if (machine.status === "revoked") return "status.revoked";
  return `status.${machine.connection}`;
}
