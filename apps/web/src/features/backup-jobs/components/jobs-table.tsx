import type { ColumnDef } from "@tanstack/react-table";
import {
  Ban,
  Container,
  DatabaseBackup,
  FolderOpen,
  History,
  PanelRightOpen,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  DataTable,
  DataTableSearch,
  RelativeTime,
  type RowAction,
  RowActionsMenu,
  rowActionsColumn,
} from "@/components/kit";
import { useLiveRuns } from "@/features/history/live/provider";
import { guestTo, pveTo } from "@/features/pve/paths";

import type { BackupJob, JobKind } from "../api.js";
import { jobDefinitionTo } from "../paths.js";
import {
  describeJobSchedule,
  describeScope,
  restoreCheckView,
  switchAction,
} from "../presenters.js";
import type { JobsAccess } from "./access-note.js";
import { JobStateBadge, NextRunCell, RestoreCheckBadge } from "./job-cells.js";
import {
  isActive,
  JOB_ACTION_CLASS,
  JobRunButton,
  type JobRunControls,
  jobActivity,
  useJobActivity,
} from "./job-run-controls.js";
import { JOB_NAME_ATTRIBUTE } from "./job-sheet.js";
import { isPveRow, type JobsListRow, type PveListRow, pveJobState } from "./pve-rows.js";

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
  /** Open the detail panel of a row (a click on the row, its name or its state). */
  onOpenPanel: (row: JobsListRow) => void;
  onEdit: (job: BackupJob) => void;
  onPause: (job: BackupJob) => void;
  onResume: (job: BackupJob) => void;
  onDelete: (job: BackupJob) => void;
  /** Start now and Stop of the rows, with the question before a stop (the page renders it). */
  controls: JobRunControls;
  /**
   * Proxmox VE in the same list (Servers & clients, #53): its jobs and its manual backups as rows,
   * with the type as a column. Absent, the table shows the machine jobs alone and no type.
   */
  pve?: {
    rows: readonly PveListRow[];
    onEdit: (row: PveListRow & { rowType: "pve" }) => void;
    onDelete: (row: PveListRow & { rowType: "pve" }) => void;
  };
}

/** Width of each column in pixels: the table never measures its content (`fixedLayout`). */
export const JOB_COLUMN_SIZES = {
  name: 220,
  type: 100,
  state: 216,
  scope: 170,
  schedule: 180,
  lastRun: 120,
  nextRun: 120,
  restoreCheck: 170,
  actions: 188,
} as const;

/** The job stays in view while the other columns scroll. */
const PINNED = ["name"] as const;

/** Worst first, the order an administrator should look at restore checks in. */
const CHECK_RANK = { failed: 0, attention: 1, none: 2, passed: 3 } as const;

function timeValue(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The state of a row in the words of the machine jobs' states. */
function rowState(row: JobsListRow) {
  if (!isPveRow(row)) return row.state;
  if (row.rowType === "pve") return pveJobState(row.job);
  return row.guest.activity === "running" ? "running" : "queued";
}

/** The slot beside the state badge: the progress while the job's backups run. */
const STATE_SLOT_CLASS = "inline-flex w-16 shrink-0 items-center gap-1";

/** The State cell: one badge, and beside it the percent of what runs (when it is known). */
function JobStateCell({ row }: { row: JobsListRow }) {
  const { t } = useTranslation("backupjobs");
  const activity = useJobActivity(row);
  const percent = isActive(activity) ? activity.percent : null;
  return (
    <div className="flex min-w-0 items-center gap-2" data-slot="job-state">
      <JobStateBadge state={rowState(row)} className="max-w-36 min-w-0" />
      <span className={STATE_SLOT_CLASS} data-slot="job-state-slot">
        {isActive(activity) && activity.running > 0 ? (
          percent === null ? (
            <span className="h-1.5 w-full animate-pulse rounded-full bg-info/30 motion-reduce:animate-none" />
          ) : (
            <>
              <span
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={t("sheet.progressOf", { name: row.name })}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <span className="block h-full bg-info" style={{ width: `${percent}%` }} />
              </span>
              <span className="w-[4ch] text-right text-xs text-muted-foreground tabular-nums">
                {percent}%
              </span>
            </>
          )
        ) : null}
      </span>
    </div>
  );
}

/** What a row covers, on one line. */
function ScopeText({ row }: { row: JobsListRow }) {
  const { t } = useTranslation("backupjobs");
  if (!isPveRow(row)) {
    return <>{describeScope(row.scope, row.kind, t, row.copy)}</>;
  }
  if (row.rowType === "manual") {
    const guest = row.guest;
    return (
      <>
        {guest.kind === "vm" ? "VM" : "CT"} {guest.vmid}
        {guest.node ? ` · ${guest.node}` : ""}
      </>
    );
  }
  return <>{t("list.pve.guests", { count: row.job.guestCount ?? 0 })}</>;
}

/** When a row runs, on one line. */
function ScheduleText({ row }: { row: JobsListRow }) {
  const { t, i18n } = useTranslation("backupjobs");
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  if (!isPveRow(row)) {
    return <>{describeJobSchedule(row.schedule, { t, tSchedules, language })}</>;
  }
  if (row.rowType === "manual") {
    return <span className="text-muted-foreground">{t("list.pve.manualSchedule")}</span>;
  }
  const schedule = row.job.schedule;
  return (
    <>
      {!schedule
        ? t("list.pve.noSchedule")
        : schedule.kind === "daily"
          ? t("auto.schedule.daily", { time: schedule.timeOfDay ?? "" })
          : t("auto.schedule.intervalHours", {
              hours: Math.round((schedule.intervalMinutes ?? 0) / 60),
            })}
    </>
  );
}

function lastRunAt(row: JobsListRow): string | null {
  if (!isPveRow(row)) return row.lastRun.at;
  return row.rowType === "pve" ? row.job.lastRunAt : (row.guest.activitySince ?? null);
}

/**
 * The jobs of one kind, one line per job in a table whose columns keep their width
 * (`fixedLayout`, 0.4.5): name, state (one badge, with the progress beside it while the job's
 * backups run), what it covers, when it runs, the last and next run, the restore checks, and one
 * action button of a fixed size ("Start now", or "Stop" while the job's backups run or wait)
 * beside the "…" menu. A click on a row, its name or its state opens the job's detail panel
 * (errors in full, the newest runs, the facts); the menu of a row ("…", or the context menu of
 * the row) opens the panel or the job, edits, starts and stops it, opens its runs, pauses (mail
 * jobs) and deletes.
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
  onOpenPanel,
  onEdit,
  onPause,
  onResume,
  onDelete,
  controls,
  pve,
}: JobsTableProps) {
  const { t } = useTranslation("backupjobs");
  const withPve = pve !== undefined;
  const pveEdit = pve?.onEdit;
  const pveDelete = pve?.onDelete;
  const liveRuns = useLiveRuns();
  // The menu reads what runs when it opens; the columns stay the same while runs move.
  const liveRef = React.useRef(liveRuns);
  liveRef.current = liveRuns;

  const columns = React.useMemo<ColumnDef<JobsListRow>[]>(() => {
    const closed = access.closed;
    const describedBy = closed ? access.noteId : undefined;
    const list: ColumnDef<JobsListRow>[] = [
      {
        id: "name",
        size: JOB_COLUMN_SIZES.name,
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
          // Where the Type column is off screen, an icon says which rows are Proxmox VE's.
          const pveRow = withPve && isPveRow(row.original);
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              {pveRow ? (
                <Container
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground 2xl:hidden"
                />
              ) : null}
              {pveRow ? <span className="sr-only">{t("list.type.pve")} </span> : null}
              <button
                type="button"
                {...{ [JOB_NAME_ATTRIBUTE]: row.original.id }}
                onClick={() => onOpenPanel(row.original)}
                className="min-w-0 truncate rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-haspopup="dialog"
              >
                {row.original.name}
              </button>
            </span>
          );
        },
      },
      ...(withPve
        ? [
            {
              id: "type",
              size: JOB_COLUMN_SIZES.type,
              accessorFn: (job: JobsListRow) => (isPveRow(job) ? 1 : 0),
              enableGlobalFilter: false,
              header: t("list.columns.type"),
              meta: { label: t("list.columns.type"), className: "hidden 2xl:table-cell" },
              cell: ({ row }: { row: { original: JobsListRow } }) => (
                <span className="text-muted-foreground">
                  {isPveRow(row.original) ? t("list.type.pve") : t("list.type.endpoint")}
                </span>
              ),
            } satisfies ColumnDef<JobsListRow>,
          ]
        : []),
      {
        id: "state",
        size: JOB_COLUMN_SIZES.state,
        accessorFn: (job) => rowState(job),
        enableGlobalFilter: false,
        enableHiding: false,
        header: t("list.columns.state"),
        meta: { label: t("list.columns.state") },
        cell: ({ row }) => (
          <button
            type="button"
            className="-mx-1 flex w-full min-w-0 rounded-sm px-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => onOpenPanel(row.original)}
            aria-label={t("sheet.openFor", { name: row.original.name })}
            aria-haspopup="dialog"
            tabIndex={-1}
          >
            <JobStateCell row={row.original} />
          </button>
        ),
      },
      {
        id: "scope",
        size: JOB_COLUMN_SIZES.scope,
        accessorFn: (job) =>
          isPveRow(job) ? (job.rowType === "pve" ? (job.job.guestCount ?? 0) : 1) : job.scope.count,
        enableGlobalFilter: false,
        header: t("list.columns.scope"),
        meta: { label: t("list.columns.scope"), className: "hidden xl:table-cell" },
        cell: ({ row }) => <ScopeText row={row.original} />,
      },
      {
        id: "schedule",
        size: JOB_COLUMN_SIZES.schedule,
        enableSorting: false,
        enableGlobalFilter: false,
        accessorFn: (job) => (isPveRow(job) ? "" : (job.schedule?.kind ?? "")),
        header: t("list.columns.schedule"),
        meta: { label: t("list.columns.schedule"), className: "hidden min-[1700px]:table-cell" },
        cell: ({ row }) => <ScheduleText row={row.original} />,
      },
      {
        id: "lastRun",
        size: JOB_COLUMN_SIZES.lastRun,
        accessorFn: (job) => timeValue(lastRunAt(job)),
        enableGlobalFilter: false,
        header: t("list.columns.lastRun"),
        meta: { label: t("list.columns.lastRun"), className: "hidden md:table-cell" },
        cell: ({ row }) => (
          <RelativeTime
            value={lastRunAt(row.original)}
            fallback={t("lastRun.never")}
            focusable={false}
          />
        ),
      },
      {
        id: "nextRun",
        size: JOB_COLUMN_SIZES.nextRun,
        accessorFn: (job) =>
          isPveRow(job)
            ? timeValue(job.rowType === "pve" ? job.job.nextRunAt : null)
            : timeValue(job.nextRunAt),
        enableGlobalFilter: false,
        header: t("list.columns.nextRun"),
        meta: {
          label: t("list.columns.nextRun"),
          className: "hidden min-[1900px]:table-cell",
        },
        cell: ({ row }) => {
          const job = row.original;
          if (!isPveRow(job)) return <NextRunCell job={job} />;
          if (job.rowType === "pve" && job.job.nextRunAt) {
            return <RelativeTime value={job.job.nextRunAt} focusable={false} />;
          }
          return (
            <span className="text-muted-foreground">
              {job.rowType === "pve" && !job.job.enabled ? t("nextRun.paused") : "–"}
            </span>
          );
        },
      },
      {
        id: "restoreCheck",
        size: JOB_COLUMN_SIZES.restoreCheck,
        accessorFn: (job) =>
          isPveRow(job) ? CHECK_RANK.none : CHECK_RANK[restoreCheckView(job.restoreCheck).state],
        enableGlobalFilter: false,
        header: t("list.columns.restoreCheck"),
        meta: {
          label: t("list.columns.restoreCheck"),
          className: "hidden min-[1400px]:table-cell",
        },
        cell: ({ row }) =>
          isPveRow(row.original) ? (
            // Every guest's newest restore point is read back weekly; its result is on the guest.
            <span className="text-muted-foreground">{t("list.pve.restoreCheck")}</span>
          ) : (
            <RestoreCheckBadge check={row.original.restoreCheck} compact />
          ),
      },
    ];

    const actionsOf = (job: JobsListRow): RowAction[] => {
      const activity = jobActivity(job, liveRef.current);
      const active = isActive(activity);
      const stopRequested = active && (activity.cancelling || controls.stopRequested(job));
      const stop: RowAction = {
        id: "stop",
        label: stopRequested ? t("stop.stopping") : t("stop.action"),
        icon: Ban,
        disabled: closed || stopRequested,
        describedBy,
        onSelect: () => controls.askStop(job),
      };
      const details: RowAction = {
        id: "details",
        label: t("sheet.details"),
        icon: PanelRightOpen,
        onSelect: () => onOpenPanel(job),
      };
      if (isPveRow(job)) {
        if (job.rowType === "manual") {
          return [
            details,
            {
              id: "open",
              label: t("actions.openGuest"),
              icon: FolderOpen,
              link: guestTo(job.guest.id),
            },
            ...(active ? [stop] : []),
          ];
        }
        return [
          details,
          { id: "open", label: t("actions.openPve"), icon: FolderOpen, link: pveTo() },
          {
            id: "edit",
            label: t("actions.edit"),
            icon: Pencil,
            disabled: closed || !pveEdit,
            describedBy,
            onSelect: () => pveEdit?.(job),
          },
          active
            ? stop
            : {
                id: "run",
                label: t("actions.runNow"),
                icon: DatabaseBackup,
                disabled: closed || !job.job.enabled || controls.starting(job),
                describedBy,
                onSelect: () => controls.start(job),
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
        details,
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
          disabled: closed || job.scope.count === 0,
          reason: !closed && job.scope.count === 0 ? t("run.emptyScope") : undefined,
          describedBy,
          onSelect: () => controls.start(job),
        },
      ];
      if (active) {
        actions.push(stop);
      }
      actions.push({
        id: "history",
        label: t("actions.openHistory"),
        icon: History,
        link: jobDefinitionTo(job.id, job.kind, "runs"),
      });
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
    };
    const menu = rowActionsColumn<JobsListRow>({
      name: (job) => job.name,
      describedBy,
      actions: actionsOf,
    });
    list.push({
      ...menu,
      size: JOB_COLUMN_SIZES.actions,
      meta: { ...menu.meta, className: "text-right", cellClassName: "py-0" },
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <JobRunButton
            row={row.original}
            controls={controls}
            access={access}
            className={JOB_ACTION_CLASS}
          />
          <RowActionsMenu
            actions={actionsOf(row.original)}
            name={row.original.name}
            describedBy={describedBy}
          />
        </div>
      ),
    } as ColumnDef<JobsListRow>);
    return list;
  }, [
    t,
    access,
    onOpenPanel,
    onEdit,
    onPause,
    onResume,
    onDelete,
    withPve,
    pveEdit,
    pveDelete,
    controls,
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
      fixedLayout
      skeletonRows={6}
      pinnedColumns={PINNED}
      onRowClick={onOpenPanel}
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
