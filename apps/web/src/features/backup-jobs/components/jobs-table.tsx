import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { DatabaseBackup, FolderOpen, History, Pause, Pencil, Play, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, DataTableSearch, type RowAction, rowActionsColumn } from "@/components/kit";

import { guestTo, pveTo } from "@/features/pve/paths";

import type { BackupJob, JobKind } from "../api.js";
import { jobDefinitionTo } from "../paths.js";
import { repositoryLabel, restoreCheckView, switchAction } from "../presenters.js";
import type { JobsAccess } from "./access-note.js";
import {
  JobLivePercent,
  JobStateBadge,
  LastRunCell,
  NextRunCell,
  RepositoryCell,
  RestoreCheckBadge,
  ScheduleCell,
  ScopeCell,
} from "./job-cells.js";
import {
  isPveRow,
  type JobsListRow,
  PveLastRunCell,
  type PveListRow,
  PveNameCell,
  PveNextRunCell,
  PveScheduleCell,
  PveScopeCell,
  PveTypeCell,
} from "./pve-rows.js";

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
  /** A "Run now" is on its way: the menu entry stays closed so a second click cannot repeat it. */
  running?: boolean;
  onPause: (job: BackupJob) => void;
  onResume: (job: BackupJob) => void;
  onDelete: (job: BackupJob) => void;
  /**
   * Proxmox VE in the same list (Servers & clients, #53): its jobs and its manual backups as rows,
   * with the type as a column. Absent, the table shows the machine jobs alone and no type.
   */
  pve?: {
    rows: readonly PveListRow[];
    onOpen: (row: PveListRow) => void;
    onEdit: (row: PveListRow & { rowType: "pve" }) => void;
    onDelete: (row: PveListRow & { rowType: "pve" }) => void;
  };
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
 * menu of a row ("…", or the context menu of the row) opens, edits, runs it now,
 * opens its runs, pauses (mail jobs) and deletes.
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
  running = false,
  onPause,
  onResume,
  onDelete,
  pve,
}: JobsTableProps) {
  const { t } = useTranslation("backupjobs");
  const withPve = pve !== undefined;
  const pveOpen = pve?.onOpen;
  const pveEdit = pve?.onEdit;
  const pveDelete = pve?.onDelete;

  const columns = React.useMemo<ColumnDef<JobsListRow>[]>(() => {
    const list: ColumnDef<JobsListRow>[] = [
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
          if (isPveRow(job)) {
            return <PveNameCell row={job} />;
          }
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
      ...(withPve
        ? [
            {
              id: "type",
              size: 120,
              accessorFn: (job: JobsListRow) => (isPveRow(job) ? 1 : 0),
              enableGlobalFilter: false,
              header: t("list.columns.type"),
              meta: { label: t("list.columns.type") },
              cell: ({ row }: { row: { original: JobsListRow } }) => (
                <PveTypeCell row={row.original} />
              ),
            } satisfies ColumnDef<JobsListRow>,
          ]
        : []),
      {
        id: "scope",
        size: 190,
        accessorFn: (job) =>
          isPveRow(job) ? (job.rowType === "pve" ? (job.job.guestCount ?? 0) : 1) : job.scope.count,
        enableGlobalFilter: false,
        header: t("list.columns.scope"),
        meta: { label: t("list.columns.scope") },
        cell: ({ row }) =>
          isPveRow(row.original) ? (
            <PveScopeCell row={row.original} />
          ) : (
            <ScopeCell job={row.original} />
          ),
      },
      {
        id: "schedule",
        size: 190,
        enableSorting: false,
        enableGlobalFilter: false,
        accessorFn: (job) => (isPveRow(job) ? "" : (job.schedule?.kind ?? "")),
        header: t("list.columns.schedule"),
        meta: { label: t("list.columns.schedule") },
        cell: ({ row }) =>
          isPveRow(row.original) ? (
            <PveScheduleCell row={row.original} />
          ) : (
            <ScheduleCell job={row.original} />
          ),
      },
      {
        id: "repository",
        size: 140,
        accessorFn: (job) => (isPveRow(job) ? "" : repositoryLabel(job.repository, t)),
        enableGlobalFilter: false,
        header: t("list.columns.repository"),
        meta: { label: t("list.columns.repository"), className: "hidden 2xl:table-cell" },
        cell: ({ row }) => {
          const job = row.original;
          return (
            <span className="text-muted-foreground">
              {/* A guest writes to its cluster's repository (the PVE storage). */}
              {isPveRow(job) ? t("list.pve.repository") : <RepositoryCell job={job} />}
            </span>
          );
        },
      },
      {
        id: "lastRun",
        size: 150,
        accessorFn: (job) =>
          isPveRow(job)
            ? timeValue(
                job.rowType === "pve" ? job.job.lastRunAt : (job.guest.activitySince ?? null),
              )
            : timeValue(job.lastRun.at),
        enableGlobalFilter: false,
        header: t("list.columns.lastRun"),
        meta: { label: t("list.columns.lastRun"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) => {
          const job = row.original;
          return (
            <div className="space-y-1">
              {isPveRow(job) ? <PveLastRunCell row={job} /> : <LastRunCell job={job} />}
              {/* Where the next run has no column of its own, it stands under the last one. */}
              <div className="text-xs text-muted-foreground 2xl:hidden">
                {t("list.nextInline")}{" "}
                {isPveRow(job) ? <PveNextRunCell row={job} /> : <NextRunCell job={job} />}
              </div>
            </div>
          );
        },
      },
      {
        id: "nextRun",
        size: 120,
        accessorFn: (job) =>
          isPveRow(job)
            ? timeValue(job.rowType === "pve" ? job.job.nextRunAt : null)
            : timeValue(job.nextRunAt),
        enableGlobalFilter: false,
        header: t("list.columns.nextRun"),
        meta: {
          label: t("list.columns.nextRun"),
          className: "hidden 2xl:table-cell",
          headerClassName: "whitespace-nowrap",
        },
        cell: ({ row }) =>
          isPveRow(row.original) ? (
            <PveNextRunCell row={row.original} />
          ) : (
            <NextRunCell job={row.original} />
          ),
      },
      {
        id: "restoreCheck",
        size: 150,
        accessorFn: (job) =>
          isPveRow(job) ? CHECK_RANK.none : CHECK_RANK[restoreCheckView(job.restoreCheck).state],
        enableGlobalFilter: false,
        header: t("list.columns.restoreCheck"),
        meta: { label: t("list.columns.restoreCheck"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) =>
          isPveRow(row.original) ? (
            // Every guest's newest restore point is read back weekly; its result is on the guest.
            <span className="text-muted-foreground">{t("list.pve.restoreCheck")}</span>
          ) : (
            <RestoreCheckBadge check={row.original.restoreCheck} />
          ),
      },
      rowActionsColumn<JobsListRow>({
        name: (job) => job.name,
        describedBy: access.closed ? access.noteId : undefined,
        actions: (job): RowAction[] => {
          const closed = access.closed;
          const describedBy = closed ? access.noteId : undefined;
          if (isPveRow(job)) {
            if (job.rowType === "manual") {
              return [
                {
                  id: "open",
                  label: t("actions.openGuest"),
                  icon: FolderOpen,
                  link: guestTo(job.guest.id),
                },
              ];
            }
            return [
              { id: "open", label: t("actions.open"), icon: FolderOpen, link: pveTo() },
              {
                id: "edit",
                label: t("actions.edit"),
                icon: Pencil,
                disabled: closed || !pveEdit,
                describedBy,
                onSelect: () => pveEdit?.(job),
              },
              {
                id: "delete",
                label: t("actions.delete"),
                icon: Trash2,
                destructive: true,
                disabled: closed || !pveDelete,
                describedBy,
                onSelect: () => pveDelete?.(job),
              },
            ];
          }
          const actions: RowAction[] = [
            {
              id: "open",
              label: t("actions.open"),
              icon: FolderOpen,
              link: jobDefinitionTo(job.id, job.kind),
            },
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
              disabled: closed || running || job.scope.count === 0,
              describedBy,
              onSelect: () => onRun(job),
            },
            {
              id: "history",
              label: t("actions.openHistory"),
              icon: History,
              link: jobDefinitionTo(job.id, job.kind, "runs"),
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
      }) as ColumnDef<JobsListRow>,
    ];
    return list;
  }, [
    t,
    access.closed,
    access.noteId,
    onEdit,
    onRun,
    running,
    onPause,
    onResume,
    onDelete,
    withPve,
    pveEdit,
    pveDelete,
  ]);

  const data = React.useMemo<readonly JobsListRow[] | undefined>(
    () => (items && pve ? [...items, ...pve.rows] : items),
    [items, pve],
  );

  return (
    <DataTable
      id={`backup-jobs-${kind}`}
      label={t(`list.table.${kind}`)}
      columns={columns}
      data={data}
      getRowId={(job) => job.id}
      loading={loading}
      fetching={fetching}
      error={error}
      onRetry={onRetry}
      errorTitle={t("list.loadError")}
      empty={empty}
      pinnedColumns={PINNED}
      onRowClick={(job) => {
        if (isPveRow(job)) {
          pveOpen?.(job);
          return;
        }
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
        (data?.length ?? 0) > 5 ? (
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
