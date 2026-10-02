import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { DatabaseBackup, Pause, Pencil, Play, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, DataTableSearch, type RowAction, rowActionsColumn } from "@/components/kit";

import type { BackupJob, JobKind } from "../api.js";
import { jobDefinitionTo } from "../paths.js";
import { repositoryLabel, restoreCheckView, switchAction } from "../presenters.js";
import type { JobsAccess } from "./access-note.js";
import {
  JobLivePercent,
  JobStateBadge,
  LastRunCell,
  NextRunCell,
  RestoreCheckBadge,
  ScheduleCell,
  ScopeCell,
} from "./job-cells.js";

export interface JobsTableProps {
  kind: JobKind;
  /** The tenant's jobs of this kind; `undefined` until the first load finished. */
  items: readonly BackupJob[] | undefined;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  /** Shown instead of the body when the tenant has no job of this kind. */
  empty: React.ReactNode;
  access: JobsAccess;
  onOpen: (job: BackupJob) => void;
  /**
   * Open the drawer of a run: the job's current or last one. A click on a row does this when the
   * job has a run, else it opens the job.
   */
  onOpenRun?: (runId: string) => void;
  onEdit: (job: BackupJob) => void;
  onRun: (job: BackupJob) => void;
  onPause: (job: BackupJob) => void;
  onResume: (job: BackupJob) => void;
  onDelete: (job: BackupJob) => void;
}

/** The job stays in view while the other columns scroll. */
const PINNED = ["name"] as const;

/** Worst first, the order an administrator should look at restore checks in. */
const CHECK_RANK = { failed: 0, attention: 1, none: 2, passed: 3 } as const;

function timeValue(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The jobs of one kind: name with its state, what they cover, when they run,
 * where they write, the last and the next run and how the restore checks stand.
 * A click on a row opens the job; the name is its own link for the keyboard. The
 * menu of a row edits, runs, pauses (mail jobs) and deletes.
 */
export function JobsTable({
  kind,
  items,
  loading,
  fetching,
  error,
  onRetry,
  empty,
  access,
  onOpen,
  onOpenRun,
  onEdit,
  onRun,
  onPause,
  onResume,
  onDelete,
}: JobsTableProps) {
  const { t } = useTranslation("backupjobs");

  const columns = React.useMemo<ColumnDef<BackupJob>[]>(() => {
    const list: ColumnDef<BackupJob>[] = [
      {
        id: "name",
        size: 240,
        accessorKey: "name",
        header: t("list.columns.name"),
        meta: { label: t("list.columns.name") },
        enableHiding: false,
        sortingFn: (a, b) =>
          a.original.name.localeCompare(b.original.name, undefined, {
            sensitivity: "base",
            numeric: true,
          }),
        cell: ({ row }) => {
          const job = row.original;
          const target = jobDefinitionTo(job.id, job.kind);
          return (
            <div className="min-w-0 space-y-1">
              <Link
                to={target.to}
                search={target.search as never}
                className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                title={job.name}
              >
                {job.name}
              </Link>
              <div className="flex items-center gap-2">
                <JobStateBadge state={job.state} />
                <JobLivePercent jobId={job.id} />
              </div>
            </div>
          );
        },
      },
      {
        id: "scope",
        size: 190,
        accessorFn: (job) => job.scope.count,
        enableGlobalFilter: false,
        header: t("list.columns.scope"),
        meta: { label: t("list.columns.scope") },
        cell: ({ row }) => <ScopeCell job={row.original} />,
      },
      {
        id: "schedule",
        size: 190,
        enableSorting: false,
        enableGlobalFilter: false,
        accessorFn: (job) => job.schedule?.kind ?? "",
        header: t("list.columns.schedule"),
        meta: { label: t("list.columns.schedule") },
        cell: ({ row }) => <ScheduleCell job={row.original} />,
      },
      {
        id: "repository",
        size: 140,
        accessorFn: (job) => repositoryLabel(job.repository, t),
        enableGlobalFilter: false,
        header: t("list.columns.repository"),
        meta: { label: t("list.columns.repository"), className: "hidden 2xl:table-cell" },
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {repositoryLabel(row.original.repository, t)}
          </span>
        ),
      },
      {
        id: "lastRun",
        size: 150,
        accessorFn: (job) => timeValue(job.lastRun.at),
        enableGlobalFilter: false,
        header: t("list.columns.lastRun"),
        meta: { label: t("list.columns.lastRun"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) => (
          <div className="space-y-1">
            <LastRunCell job={row.original} />
            {/* Where the next run has no column of its own, it stands under the last one. */}
            <div className="text-xs text-muted-foreground 2xl:hidden">
              {t("list.nextInline")} <NextRunCell job={row.original} />
            </div>
          </div>
        ),
      },
      {
        id: "nextRun",
        size: 120,
        accessorFn: (job) => timeValue(job.nextRunAt),
        enableGlobalFilter: false,
        header: t("list.columns.nextRun"),
        meta: {
          label: t("list.columns.nextRun"),
          className: "hidden 2xl:table-cell",
          headerClassName: "whitespace-nowrap",
        },
        cell: ({ row }) => <NextRunCell job={row.original} />,
      },
      {
        id: "restoreCheck",
        size: 150,
        accessorFn: (job) => CHECK_RANK[restoreCheckView(job.restoreCheck).state],
        enableGlobalFilter: false,
        header: t("list.columns.restoreCheck"),
        meta: { label: t("list.columns.restoreCheck"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) => <RestoreCheckBadge check={row.original.restoreCheck} />,
      },
      rowActionsColumn<BackupJob>({
        name: (job) => job.name,
        describedBy: access.closed ? access.noteId : undefined,
        actions: (job): RowAction[] => {
          const closed = access.closed;
          const describedBy = closed ? access.noteId : undefined;
          const actions: RowAction[] = [
            {
              id: "edit",
              label: t("actions.edit"),
              icon: Pencil,
              disabled: closed,
              describedBy,
              onSelect: () => onEdit(job),
            },
            {
              id: "run",
              label: t("actions.runNow"),
              icon: DatabaseBackup,
              disabled: closed || job.scope.count === 0,
              describedBy,
              onSelect: () => onRun(job),
            },
          ];
          const change = switchAction(job);
          if (change === "pause") {
            actions.push({
              id: "pause",
              label: t("actions.pause"),
              icon: Pause,
              disabled: closed,
              describedBy,
              onSelect: () => onPause(job),
            });
          } else if (change === "resume") {
            actions.push({
              id: "resume",
              label: t("actions.resume"),
              icon: Play,
              disabled: closed,
              describedBy,
              onSelect: () => onResume(job),
            });
          }
          actions.push({
            id: "delete",
            label: t("actions.delete"),
            icon: Trash2,
            destructive: true,
            disabled: closed,
            describedBy,
            onSelect: () => onDelete(job),
          });
          return actions;
        },
      }) as ColumnDef<BackupJob>,
    ];
    return list;
  }, [t, access.closed, access.noteId, onEdit, onRun, onPause, onResume, onDelete]);

  return (
    <DataTable
      id={`backup-jobs-${kind}`}
      label={t(`list.table.${kind}`)}
      columns={columns}
      data={items}
      getRowId={(job) => job.id}
      loading={loading}
      fetching={fetching}
      error={error}
      onRetry={onRetry}
      errorTitle={t("list.loadError")}
      empty={empty}
      pinnedColumns={PINNED}
      onRowClick={(job) => {
        const runId = job.lastRun.runId;
        if (runId && onOpenRun) {
          onOpenRun(runId);
        } else {
          onOpen(job);
        }
      }}
      sorting={{ mode: "client", initial: [{ id: "name", desc: false }] }}
      pagination={{ mode: "client", pageSize: 25 }}
      toolbar={(table) =>
        (items?.length ?? 0) > 5 ? (
          <DataTableSearch
            value={String(table.getState().globalFilter ?? "")}
            onChange={(value) => table.setGlobalFilter(value)}
            placeholder={t("list.search")}
          />
        ) : null
      }
    />
  );
}
