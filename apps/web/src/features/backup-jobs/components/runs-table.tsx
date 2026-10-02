import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, RelativeTime, StatusBadge } from "@/components/kit";
import type { RunKind, RunStatus } from "@/features/endpoints/api";
import { RunStatusBadge } from "@/features/endpoints/components/status";
import { endpointDetailTo } from "@/features/endpoints/paths";
import { JOB_QUEUES, JOB_STATUSES, type JobQueue, type JobStatus } from "@/features/jobs/api";
import { JobStatusBadge } from "@/features/jobs/components/status";
import { jobDetailTo } from "@/features/jobs/paths";

import type { BackupJob, JobRun } from "../api.js";

export interface RunsTableProps {
  job: BackupJob;
  items: readonly JobRun[] | undefined;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
}

const PINNED = ["type"] as const;

const RUN_KINDS: readonly string[] = ["backup", "restore", "verify_sample"];
const RUN_STATUSES: readonly string[] = ["running", "succeeded", "partial", "failed"];

function timeValue(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The status of a run the way its own page words it: a queue run like History, an agent run like the machine page. */
function RunBadge({ run }: { run: JobRun }) {
  const { t } = useTranslation("backupjobs");
  if (
    run.source === "endpoint" &&
    RUN_STATUSES.includes(run.status) &&
    RUN_KINDS.includes(run.type)
  ) {
    return <RunStatusBadge status={run.status as RunStatus} kind={run.type as RunKind} />;
  }
  if (run.source === "mail" && (JOB_STATUSES as readonly string[]).includes(run.status)) {
    return (
      <JobStatusBadge
        status={run.status as JobStatus}
        queue={
          (JOB_QUEUES as readonly string[]).includes(run.type) ? (run.type as JobQueue) : undefined
        }
      />
    );
  }
  return <StatusBadge tone="muted">{t("runs.statusOther", { status: run.status })}</StatusBadge>;
}

/**
 * The runs of the job, newest first: what ran, for which object or machine, how it
 * ended and when. A mail run opens its page in History; a machine run belongs to
 * the machine, whose page lists its runs.
 */
export function RunsTable({ job, items, loading, fetching, error, onRetry }: RunsTableProps) {
  const { t } = useTranslation("backupjobs");
  const { t: tBackup } = useTranslation("backup");
  const { t: tEndpoints } = useTranslation("endpoints");

  const columns = React.useMemo<ColumnDef<JobRun>[]>(() => {
    const typeLabel = (run: JobRun) =>
      run.source === "endpoint"
        ? RUN_KINDS.includes(run.type)
          ? tEndpoints(`runKind.${run.type}`)
          : run.type
        : (JOB_QUEUES as readonly string[]).includes(run.type)
          ? tBackup(`queue.${run.type}`)
          : run.type;
    return [
      {
        id: "type",
        size: 190,
        enableSorting: false,
        accessorFn: (run) => typeLabel(run),
        header: t("runs.columns.type"),
        meta: { label: t("runs.columns.type") },
        enableHiding: false,
        cell: ({ row }) => {
          const run = row.original;
          if (run.source === "mail") {
            return (
              <Link
                to={jobDetailTo(run.id)}
                className="inline-flex items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label={t("runs.open", { type: typeLabel(run) })}
              >
                {typeLabel(run)}
                <ExternalLink aria-hidden="true" className="size-3 text-muted-foreground" />
              </Link>
            );
          }
          return <span className="font-medium">{typeLabel(run)}</span>;
        },
      },
      {
        id: "target",
        size: 220,
        enableSorting: false,
        accessorFn: (run) => run.targetName ?? "",
        header: t("runs.columns.target"),
        meta: { label: t("runs.columns.target") },
        cell: ({ row }) => {
          const run = row.original;
          if (!run.targetName) {
            return <span className="text-muted-foreground">{t("runs.wholeJob")}</span>;
          }
          return run.source === "endpoint" && run.targetId ? (
            <Link
              to={endpointDetailTo(run.targetId)}
              className="rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {run.targetName}
            </Link>
          ) : (
            <span>{run.targetName}</span>
          );
        },
      },
      {
        id: "status",
        size: 170,
        enableSorting: false,
        accessorFn: (run) => run.status,
        header: t("runs.columns.status"),
        meta: { label: t("runs.columns.status") },
        cell: ({ row }) => <RunBadge run={row.original} />,
      },
      {
        id: "started",
        size: 140,
        accessorFn: (run) => timeValue(run.startedAt ?? run.createdAt),
        header: t("runs.columns.started"),
        meta: { label: t("runs.columns.started"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) => (
          <RelativeTime
            value={row.original.startedAt ?? row.original.createdAt}
            focusable={false}
          />
        ),
      },
      {
        id: "finished",
        size: 140,
        accessorFn: (run) => timeValue(run.finishedAt),
        header: t("runs.columns.finished"),
        meta: {
          label: t("runs.columns.finished"),
          className: "hidden md:table-cell",
          headerClassName: "whitespace-nowrap",
        },
        cell: ({ row }) => (
          <RelativeTime
            value={row.original.finishedAt}
            fallback={t("runs.notFinished")}
            focusable={false}
          />
        ),
      },
    ];
  }, [t, tBackup, tEndpoints]);

  return (
    <DataTable
      id={`backup-job-runs-${job.kind}`}
      label={t("runs.table")}
      columns={columns}
      data={items}
      getRowId={(run) => `${run.source}:${run.id}`}
      loading={loading}
      fetching={fetching}
      error={error}
      onRetry={onRetry}
      errorTitle={t("runs.loadError")}
      empty={<p className="py-6 text-center text-sm text-muted-foreground">{t("runs.empty")}</p>}
      pinnedColumns={PINNED}
      sorting={{ mode: "client", initial: [{ id: "started", desc: true }] }}
      columnsMenu={false}
    />
  );
}
