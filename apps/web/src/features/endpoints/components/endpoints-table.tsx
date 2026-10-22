import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Ban,
  CircleSlash,
  FolderOpen,
  FolderSearch,
  ListChecks,
  ListPlus,
  PanelRightOpen,
  Play,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  ConfirmDialog,
  DataTable,
  DataTableFacetedFilter,
  DataTableSearch,
  EmptyState,
  matchesAnyOf,
  RelativeTime,
  type RowAction,
  RowActionsMenu,
  rowActionsColumn,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useJobsAccess } from "@/features/backup-jobs/components/access-note";
import { useJobActions } from "@/features/backup-jobs/components/job-actions";
import { jobDefinitionTo, linkProps, newJobTo } from "@/features/backup-jobs/paths";
import { cn } from "@/lib/utils";

import type { EndpointSummary } from "../api.js";
import { useBackupNow } from "../hooks.js";
import {
  MACHINE_STATUS_ORDER,
  type MachineStatusKey,
  machineStatuses,
  machineStatusRank,
} from "../machine-status.js";
import { type EndpointArea, endpointDetailTo, fileRestoreTo } from "../paths.js";
import {
  assigneeFilterOptions,
  assigneeFilterValue,
  assigneeName,
  backupGroupsOf,
  endpointName,
  isWithoutBackup,
  lastBackupOf,
  splitRevoked,
} from "../presenters.js";
import { AddToJobDialog, type JobCandidate } from "./add-to-job-dialog.js";
import { AssignDialog, type AssignTarget, useAssignAccess } from "./assign-dialog.js";
import {
  MACHINE_ACTION_CLASS,
  MachineActionButton,
  MachineStatusCell,
  runningBackupOf,
  useStopMachineBackup,
} from "./machine-cells.js";
import { MACHINE_NAME_ATTRIBUTE } from "./machine-sheet.js";
import { OsLabel, ProfileIcon } from "./status.js";

export interface EndpointsTableProps {
  area: EndpointArea;
  items: readonly EndpointSummary[] | undefined;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  /** Shown instead of the table body when there is no machine yet. */
  empty: React.ReactNode;
  /**
   * The viewer may manage backup jobs: a machine without backup gets "Create job" and "Add to
   * job" on its row, and the rows' "Back up now" and "Stop backup" are open.
   */
  canManageJobs?: boolean;
  /** Open the machine's detail panel (a click on the row, its name or its state). */
  onOpen?: (endpoint: EndpointSummary) => void;
}

/** Width of each column in pixels: the table never measures its content (`fixedLayout`). */
export const MACHINE_COLUMN_SIZES = {
  name: 220,
  state: 232,
  profile: 100,
  lastBackup: 120,
  system: 140,
  lastSeen: 120,
  job: 160,
  assignedTo: 150,
  agentVersion: 100,
  actions: 216,
} as const;

/** The values of the job filter: in no job (not backed up), or in one. */
type JobFilterValue = "without" | "in_job";
const JOB_FILTER_ORDER: readonly JobFilterValue[] = ["without", "in_job"];

function jobFilterValue(endpoint: EndpointSummary): JobFilterValue | "other" {
  if (endpoint.job) return "in_job";
  return isWithoutBackup(endpoint) ? "without" : "other";
}

/** The machine stays in view while the other columns scroll. */
const PINNED = ["name"] as const;

function timeValue(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** A revoked machine, shown on request ("Show revoked machines"), is greyed out. */
function Dimmed({ revoked, children }: { revoked: boolean; children: React.ReactNode }) {
  return <div className={cn("min-w-0 truncate", revoked && "opacity-60")}>{children}</div>;
}

/** When the newest backup finished; how it ended is the State's (one badge per row). */
function LastBackupCell({ endpoint }: { endpoint: EndpointSummary }) {
  const { t } = useTranslation("endpoints");
  const last = lastBackupOf(endpoint);
  if (last.state === "running") {
    return <span className="text-muted-foreground">{t("list.backupRunning")}</span>;
  }
  if (last.state === "never") {
    return <span className="text-muted-foreground">{t("list.noBackupYet")}</span>;
  }
  return <RelativeTime value={last.at} focusable={false} />;
}

/**
 * Servers, clients or every machine with an agent (Inventory), one line per machine in a table
 * whose columns keep their width (`fixedLayout`, 0.4.5): name, state (one badge: the most urgent
 * of what applies, see machine-status.ts), last backup, system, last contact, backup job, the
 * person it is assigned to, and one action button of a fixed size ("Back up now", or "Stop
 * backup" while one runs) beside the "…" menu. The rest (every state, the full error text of
 * the newest backup, the restore check, the newest runs) is in the machine's detail panel,
 * which a click on the row, its name or its state opens.
 *
 * Every row has its actions in the "…" menu and as the context menu of the row (right click,
 * the context menu key, Shift+F10): open the details or the machine's page, back it up now or
 * stop its backup, restore its files, assign it to a person; administrators of jobs also create
 * a job for a machine without backup or add it to one. They can select machines and make a new
 * job from the selection, or add the selection to a job.
 *
 * Revoked machines are left out until "Show revoked machines (N)" is pressed (#65): revoking
 * stops a machine's backups but deletes nothing, so they would otherwise stay in the list for
 * good.
 */
export function EndpointsTable({
  area,
  items,
  loading,
  fetching,
  error,
  onRetry,
  empty,
  canManageJobs = false,
  onOpen,
}: EndpointsTableProps) {
  const { t } = useTranslation("endpoints");
  const showAgentColumns = area === "agents";
  const [adding, setAdding] = React.useState<JobCandidate[] | null>(null);
  const [assigning, setAssigning] = React.useState<AssignTarget | null>(null);
  const [stopping, setStopping] = React.useState<EndpointSummary | null>(null);
  const jobsAccess = useJobsAccess();
  const assignAccess = useAssignAccess();
  const backup = useBackupNow();
  const requestBackup = backup.request;
  const stop = useStopMachineBackup();
  const jobActions = useJobActions();
  const runJobNow = jobActions.runNow;
  const runningJobs = jobActions.running;
  const [showRevoked, setShowRevoked] = React.useState(false);
  const { active, revoked } = splitRevoked(items ?? []);
  const rows = items === undefined ? undefined : showRevoked ? items : active;
  // Backing up and stopping are the job admins' (the server checks it too), never the demo's.
  const operate = canManageJobs && !jobsAccess.closed;
  const operateReason = canManageJobs ? jobsAccess.reason : t("sheet.adminOnly");

  const columns = React.useMemo<ColumnDef<EndpointSummary>[]>(() => {
    const list: ColumnDef<EndpointSummary>[] = [
      {
        id: "name",
        size: MACHINE_COLUMN_SIZES.name,
        // The search reads the label, the host name and the person it is assigned to.
        accessorFn: (endpoint) =>
          [
            endpointName(endpoint),
            endpoint.hostname,
            endpoint.assignedTo ? assigneeName(endpoint.assignedTo) : "",
            endpoint.assignedTo?.email ?? "",
          ].join(" "),
        header: t("list.columns.name"),
        meta: { label: t("list.columns.name") },
        enableHiding: false,
        sortingFn: (a, b) =>
          endpointName(a.original).localeCompare(endpointName(b.original), undefined, {
            sensitivity: "base",
            numeric: true,
          }),
        cell: ({ row }) => {
          const endpoint = row.original;
          const name = endpointName(endpoint);
          return (
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5",
                endpoint.status === "revoked" && "opacity-60",
              )}
            >
              <ProfileIcon profile={endpoint.profile} />
              {onOpen ? (
                <button
                  type="button"
                  {...{ [MACHINE_NAME_ATTRIBUTE]: endpoint.id }}
                  onClick={() => onOpen(endpoint)}
                  className="min-w-0 truncate rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  aria-haspopup="dialog"
                >
                  {name}
                </button>
              ) : (
                <Link
                  to={endpointDetailTo(endpoint.id)}
                  className="min-w-0 truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {name}
                </Link>
              )}
            </span>
          );
        },
      },
      {
        id: "state",
        size: MACHINE_COLUMN_SIZES.state,
        // The filter matches the primary state; the order is its urgency.
        accessorFn: (endpoint) => machineStatuses(endpoint)[0]?.key ?? "unknown",
        enableGlobalFilter: false,
        header: t("list.columns.state"),
        meta: { label: t("list.columns.state") },
        enableHiding: false,
        filterFn: matchesAnyOf,
        sortingFn: (a, b) =>
          machineStatusRank(machineStatuses(a.original)) -
          machineStatusRank(machineStatuses(b.original)),
        cell: ({ row }) => {
          const endpoint = row.original;
          const statuses = machineStatuses(endpoint);
          const cell = <MachineStatusCell machine={endpoint} statuses={statuses} />;
          return onOpen ? (
            <button
              type="button"
              className="-mx-1 flex w-full min-w-0 rounded-sm px-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => onOpen(endpoint)}
              aria-label={t("sheet.openFor", { name: endpointName(endpoint) })}
              aria-haspopup="dialog"
              tabIndex={-1}
            >
              {cell}
            </button>
          ) : (
            cell
          );
        },
      },
    ];

    if (showAgentColumns) {
      list.push({
        id: "profile",
        size: MACHINE_COLUMN_SIZES.profile,
        accessorFn: (endpoint) => endpoint.profile,
        header: t("list.columns.profile"),
        meta: { label: t("list.columns.profile"), className: "hidden 2xl:table-cell" },
        filterFn: matchesAnyOf,
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            {t(`profile.${row.original.profile}`)}
          </Dimmed>
        ),
      });
    }

    list.push(
      {
        id: "lastBackup",
        size: MACHINE_COLUMN_SIZES.lastBackup,
        accessorFn: (endpoint) => timeValue(endpoint.lastBackupAt),
        enableGlobalFilter: false,
        header: t("list.columns.lastBackup"),
        meta: { label: t("list.columns.lastBackup") },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <LastBackupCell endpoint={row.original} />
          </Dimmed>
        ),
      },
      {
        id: "system",
        size: MACHINE_COLUMN_SIZES.system,
        accessorFn: (endpoint) => `${endpoint.os} ${endpoint.arch}`,
        header: t("list.columns.system"),
        meta: { label: t("list.columns.system"), className: "hidden md:table-cell" },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <OsLabel os={row.original.os} arch={row.original.arch} />
          </Dimmed>
        ),
      },
      {
        id: "lastSeen",
        size: MACHINE_COLUMN_SIZES.lastSeen,
        accessorFn: (endpoint) => timeValue(endpoint.lastSeenAt),
        enableGlobalFilter: false,
        header: t("list.columns.lastSeen"),
        meta: { label: t("list.columns.lastSeen"), className: "hidden xl:table-cell" },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <RelativeTime
              value={row.original.lastSeenAt}
              fallback={t("status.never")}
              focusable={false}
            />
          </Dimmed>
        ),
      },
      {
        id: "job",
        size: MACHINE_COLUMN_SIZES.job,
        accessorFn: jobFilterValue,
        enableGlobalFilter: false,
        header: t("list.columns.job"),
        meta: { label: t("list.columns.job") },
        filterFn: matchesAnyOf,
        sortingFn: (a, b) =>
          (a.original.job?.name ?? "").localeCompare(b.original.job?.name ?? "", undefined, {
            sensitivity: "base",
            numeric: true,
          }),
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            {row.original.job ? (
              <Link
                {...linkProps(jobDefinitionTo(row.original.job.id, "endpoint"))}
                className="rounded-sm outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {row.original.job.name}
              </Link>
            ) : isWithoutBackup(row.original) ? (
              <span className="text-muted-foreground">{t("machineStatus.no_job")}</span>
            ) : (
              <span className="text-muted-foreground">–</span>
            )}
          </Dimmed>
        ),
      },
      {
        id: "assignedTo",
        size: MACHINE_COLUMN_SIZES.assignedTo,
        accessorFn: assigneeFilterValue,
        enableGlobalFilter: false,
        header: t("list.columns.assignedTo"),
        meta: { label: t("list.columns.assignedTo"), className: "hidden lg:table-cell" },
        filterFn: matchesAnyOf,
        // By name; machines assigned to nobody come last.
        sortingFn: (a, b) => {
          const left = a.original.assignedTo;
          const right = b.original.assignedTo;
          if (!left || !right) {
            return left ? -1 : right ? 1 : 0;
          }
          return assigneeName(left).localeCompare(assigneeName(right), undefined, {
            sensitivity: "base",
            numeric: true,
          });
        },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            {row.original.assignedTo ? (
              assigneeName(row.original.assignedTo)
            ) : (
              <span className="text-muted-foreground">{t("list.assignedNobody")}</span>
            )}
          </Dimmed>
        ),
      },
    );

    if (showAgentColumns) {
      list.push({
        id: "agentVersion",
        size: MACHINE_COLUMN_SIZES.agentVersion,
        accessorFn: (endpoint) => endpoint.agentVersion ?? "",
        header: t("list.columns.agentVersion"),
        meta: { label: t("list.columns.agentVersion"), className: "hidden 2xl:table-cell" },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            {row.original.agentVersion ? (
              <span className="font-mono text-xs">{row.original.agentVersion}</span>
            ) : (
              <span className="text-muted-foreground">{t("list.unknown")}</span>
            )}
          </Dimmed>
        ),
      });
    }
    const jobsClosed = jobsAccess.closed ? jobsAccess.reason : undefined;
    const candidate = (endpoint: EndpointSummary): JobCandidate => ({
      id: endpoint.id,
      name: endpointName(endpoint),
    });
    const menu = rowActionsColumn<EndpointSummary>({
      name: endpointName,
      actions: (endpoint): RowAction[] => {
        const name = endpointName(endpoint);
        const isRevoked = endpoint.status === "revoked";
        const withoutBackup = isWithoutBackup(endpoint);
        const running = runningBackupOf(endpoint);
        const actions: RowAction[] = [];
        if (onOpen) {
          actions.push({
            id: "details",
            label: t("sheet.details"),
            icon: PanelRightOpen,
            onSelect: () => onOpen(endpoint),
          });
        }
        actions.push({
          id: "open",
          label: t("list.rowActions.open"),
          icon: FolderOpen,
          link: { to: endpointDetailTo(endpoint.id) },
        });
        actions.push({
          id: "backup",
          label: t("actions.backup.label"),
          icon: Play,
          // Backups run only in a backup job; the server refuses the request otherwise (409).
          disabled: isRevoked || withoutBackup || running !== null || !operate,
          reason: isRevoked
            ? t("list.rowActions.revoked")
            : withoutBackup
              ? t("actions.backup.needsJob")
              : running
                ? t("machineStatus.running")
                : !operate
                  ? operateReason
                  : undefined,
          onSelect: () => requestBackup(endpoint.id),
        });
        if (running) {
          actions.push({
            id: "stop",
            label: running.cancelling ? t("cancel.cancelling") : t("cancel.stop"),
            icon: Ban,
            disabled: running.cancelling || !operate,
            reason: !operate ? operateReason : undefined,
            onSelect: () => setStopping(endpoint),
          });
        }
        actions.push({
          id: "restore",
          label: t("list.rowActions.restoreFiles"),
          icon: FolderSearch,
          disabled: endpoint.readiness.latestSnapshotId === null,
          reason:
            endpoint.readiness.latestSnapshotId === null
              ? t("list.rowActions.noRestorePoint")
              : undefined,
          link: fileRestoreTo(endpoint.id),
        });
        if (canManageJobs && withoutBackup) {
          actions.push(
            {
              id: "createJob",
              label: t("noJob.createJob"),
              icon: ListPlus,
              disabled: jobsAccess.closed,
              reason: jobsClosed,
              link: newJobTo("endpoint", [endpoint.id]),
            },
            {
              id: "addToJob",
              label: t("noJob.addToJob"),
              icon: ListChecks,
              disabled: jobsAccess.closed,
              reason: jobsClosed,
              onSelect: () => setAdding([candidate(endpoint)]),
            },
          );
        }
        actions.push({
          id: "assign",
          label: t("assign.action"),
          icon: UserRound,
          disabled: isRevoked || assignAccess.closed,
          reason: isRevoked ? t("list.rowActions.revoked") : assignAccess.reason,
          onSelect: () =>
            setAssigning({ id: endpoint.id, name, assignedTo: endpoint.assignedTo ?? null }),
        });
        return actions;
      },
      selectionActions: canManageJobs
        ? (selected): RowAction[] => {
            const usable = selected.filter((endpoint) => endpoint.status === "active");
            // Only a machine in a job can be backed up (release 0.2.1); one request per job.
            const inJob = usable.filter((endpoint) => endpoint.job);
            return [
              {
                id: "backupSelection",
                label: t("list.rowActions.backupSelection", { count: inJob.length }),
                icon: Play,
                disabled: jobsAccess.closed || inJob.length === 0 || runningJobs,
                reason:
                  jobsClosed ??
                  (inJob.length === 0 ? t("list.rowActions.backupSelectionNoJob") : undefined),
                onSelect: () => {
                  for (const group of backupGroupsOf(inJob)) {
                    runJobNow(
                      { id: group.job.id, kind: "endpoint", name: group.job.name },
                      group.ids,
                    );
                  }
                },
              },
              {
                id: "newJobFromSelection",
                label: t("list.rowActions.newJobFromSelection", { count: usable.length }),
                icon: ListPlus,
                disabled: jobsAccess.closed || usable.length === 0,
                reason: jobsClosed,
                link: newJobTo(
                  "endpoint",
                  usable.map((endpoint) => endpoint.id),
                ),
              },
              {
                id: "addSelectionToJob",
                label: t("list.rowActions.addSelectionToJob", { count: usable.length }),
                icon: ListChecks,
                disabled: jobsAccess.closed || usable.length === 0,
                reason: jobsClosed,
                onSelect: () => setAdding(usable.map(candidate)),
              },
            ];
          }
        : undefined,
    });
    list.push({
      ...menu,
      size: MACHINE_COLUMN_SIZES.actions,
      meta: { ...menu.meta, className: "text-right", cellClassName: "py-0" },
      cell: ({ row }) => {
        const endpoint = row.original;
        const actions = menu.meta?.rowActions?.actions(endpoint) ?? [];
        return (
          <div className="flex items-center justify-end gap-1">
            <MachineActionButton
              machine={endpoint}
              stoppable={runningBackupOf(endpoint)}
              allowed={operate}
              reason={operateReason}
              className={MACHINE_ACTION_CLASS}
            />
            <RowActionsMenu actions={actions} name={endpointName(endpoint)} />
          </div>
        );
      },
    } as ColumnDef<EndpointSummary>);
    return list;
  }, [
    t,
    showAgentColumns,
    canManageJobs,
    jobsAccess.closed,
    jobsAccess.reason,
    assignAccess.closed,
    assignAccess.reason,
    requestBackup,
    runJobNow,
    runningJobs,
    onOpen,
    operate,
    operateReason,
  ]);

  const presentStates = new Set(
    (rows ?? []).map((endpoint) => machineStatuses(endpoint)[0]?.key ?? "unknown"),
  );
  const stateOptions = MACHINE_STATUS_ORDER.filter((key: MachineStatusKey) =>
    presentStates.has(key),
  ).map((key) => ({ value: key, label: t(`machineStatus.${key}`) }));
  const profilesPresent = new Set((rows ?? []).map((endpoint) => endpoint.profile));
  const profileOptions = (["server", "client"] as const)
    .filter((profile) => profilesPresent.has(profile))
    .map((profile) => ({ value: profile, label: t(`profile.${profile}`) }));
  const jobValues = new Set((rows ?? []).map(jobFilterValue));
  const jobOptions = JOB_FILTER_ORDER.filter((value) => jobValues.has(value)).map((value) => ({
    value,
    label: t(`list.jobFilter.${value}`),
  }));
  const assigneeOptions = assigneeFilterOptions(rows ?? [], t("list.assignedNobody"));
  const stoppingName = stopping ? endpointName(stopping) : "";
  const revokedToggle =
    revoked.length > 0 ? (
      <Button
        type="button"
        size="sm"
        variant={showRevoked ? "secondary" : "outline"}
        aria-pressed={showRevoked}
        data-slot="show-revoked"
        onClick={() => setShowRevoked((value) => !value)}
      >
        <CircleSlash aria-hidden="true" />
        {t("list.showRevoked", { count: revoked.length })}
      </Button>
    ) : null;

  return (
    <>
      <DataTable
        id={`endpoints-${area}`}
        label={t(`areas.${area}.title`)}
        columns={columns}
        data={rows}
        getRowId={(endpoint) => endpoint.id}
        loading={loading}
        fetching={fetching}
        error={error}
        onRetry={onRetry}
        errorTitle={t("list.errors.load")}
        fixedLayout
        skeletonRows={8}
        onRowClick={onOpen}
        empty={
          // Every machine is revoked and hidden: say so instead of "no machine yet".
          revoked.length > 0 && !showRevoked ? (
            <EmptyState
              variant="plain"
              icon={CircleSlash}
              title={t("list.onlyRevoked.title")}
              description={t("list.onlyRevoked.description")}
              actions={revokedToggle}
            />
          ) : (
            empty
          )
        }
        pinnedColumns={PINNED}
        // Selecting machines serves the job actions: a new job from them, or an existing one.
        selectable={canManageJobs}
        sorting={{ mode: "client", initial: [{ id: "name", desc: false }] }}
        pagination={{ mode: "client", pageSize: 25 }}
        toolbar={(table) => (
          <>
            <DataTableSearch
              value={String(table.getState().globalFilter ?? "")}
              onChange={(value) => table.setGlobalFilter(value)}
              placeholder={t("list.search")}
            />
            {stateOptions.length > 1 ? (
              <DataTableFacetedFilter
                title={t("list.columns.state")}
                options={stateOptions}
                column={table.getColumn("state")}
              />
            ) : null}
            {showAgentColumns && profileOptions.length > 1 ? (
              <DataTableFacetedFilter
                title={t("list.columns.profile")}
                options={profileOptions}
                column={table.getColumn("profile")}
              />
            ) : null}
            {jobOptions.length > 1 ? (
              <DataTableFacetedFilter
                title={t("list.columns.job")}
                options={jobOptions}
                column={table.getColumn("job")}
              />
            ) : null}
            {assigneeOptions.length > 1 ? (
              <DataTableFacetedFilter
                title={t("list.columns.assignedTo")}
                options={assigneeOptions}
                column={table.getColumn("assignedTo")}
              />
            ) : null}
            {revokedToggle}
          </>
        )}
      />
      {/* "Stop backup" from the "…" menu asks the same question as the row's button. */}
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(open) => {
          if (!open) setStopping(null);
        }}
        title={t("cancel.stopTitle", { name: stoppingName })}
        description={t("cancel.stopBody")}
        confirmLabel={t("cancel.stopConfirm")}
        cancelLabel={t("cancel.keep")}
        destructive
        pending={stop.isPending}
        onConfirm={() =>
          stopping
            ? stop.mutateAsync(stopping.id).then(() => {
                setStopping(null);
                toast.success(t("cancel.stopping"), { description: t("cancel.stoppingNote") });
              })
            : undefined
        }
      />
      {/* Mounted while a row asks for it: the dialog loads the jobs only then. */}
      {canManageJobs && adding !== null ? (
        <AddToJobDialog
          open
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          endpoints={adding}
        />
      ) : null}
      {/* Likewise: the people of the directory are searched only while it is open. */}
      {assigning !== null ? (
        <AssignDialog
          open
          onOpenChange={(open) => {
            if (!open) setAssigning(null);
          }}
          target={assigning}
        />
      ) : null}
    </>
  );
}
