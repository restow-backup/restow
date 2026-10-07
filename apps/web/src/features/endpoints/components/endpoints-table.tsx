import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
  FolderOpen,
  FolderSearch,
  Info,
  ListChecks,
  ListPlus,
  Play,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  DataTable,
  DataTableFacetedFilter,
  DataTableSearch,
  RelativeTime,
  type RowAction,
  StatusBadge,
  matchesAnyOf,
  rowActionsColumn,
} from "@/components/kit";
import { useJobsAccess } from "@/features/backup-jobs/components/access-note";
import { useJobActions } from "@/features/backup-jobs/components/job-actions";
import { newJobTo } from "@/features/backup-jobs/paths";
import { cn } from "@/lib/utils";

import type { Attention, EndpointSummary, ReadinessState } from "../api.js";
import { useBackupNow } from "../hooks.js";
import { type EndpointArea, endpointDetailTo, fileRestoreTo } from "../paths.js";
import {
  assigneeFilterOptions,
  assigneeFilterValue,
  assigneeName,
  backupGroupsOf,
  endpointHostLine,
  endpointName,
  isWithoutBackup,
  lastBackupOf,
} from "../presenters.js";
import { AddToJobDialog, type JobCandidate } from "./add-to-job-dialog.js";
import { AssignDialog, type AssignTarget, useAssignAccess } from "./assign-dialog.js";
import {
  ActivityBadge,
  AttentionBadges,
  ConnectionBadge,
  OsLabel,
  ProfileBadge,
  ProfileIcon,
  ReadinessBadge,
} from "./status.js";
import { JobCell } from "./without-backup.js";

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
   * job" on its row.
   */
  canManageJobs?: boolean;
}

/** Worst first, the order an admin should look at machines in. */
const READINESS_RANK: Record<ReadinessState, number> = {
  red: 0,
  no_backup: 1,
  unverified: 2,
  yellow: 3,
  green: 4,
};

const READINESS_ORDER = ["red", "no_backup", "unverified", "yellow", "green"] as const;

/** The values of the job filter: in no job (not backed up), or in one. */
type JobFilterValue = "without" | "in_job";
const JOB_FILTER_ORDER: readonly JobFilterValue[] = ["without", "in_job"];

function jobFilterValue(endpoint: EndpointSummary): JobFilterValue | "other" {
  if (endpoint.job) return "in_job";
  return isWithoutBackup(endpoint) ? "without" : "other";
}

/** The job column says "without backup" already; the attention column leaves it out. */
function otherAttention(attention: readonly Attention[]): Attention[] {
  return attention.filter((item) => item !== "no_job");
}
/** The machine stays in view while the other columns scroll. */
const PINNED = ["name"] as const;

function timeValue(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** A revoked machine stays in the list, greyed out. */
function Dimmed({ revoked, children }: { revoked: boolean; children: React.ReactNode }) {
  return <div className={cn("min-w-0", revoked && "opacity-60")}>{children}</div>;
}

function LastBackupCell({ endpoint }: { endpoint: EndpointSummary }) {
  const { t } = useTranslation("endpoints");
  const last = lastBackupOf(endpoint);
  if (last.state === "running") {
    return <span className="text-muted-foreground">{t("list.backupRunning")}</span>;
  }
  if (last.state === "never") {
    return <span className="text-muted-foreground">{t("list.noBackupYet")}</span>;
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <RelativeTime value={last.at} focusable={false} />
      {last.outcome === "failed" ? (
        <StatusBadge tone="destructive" icon={TriangleAlert} className="whitespace-nowrap">
          {t("list.backupFailed")}
        </StatusBadge>
      ) : last.outcome === "interrupted" ? (
        <StatusBadge tone="info" icon={Info} className="whitespace-nowrap">
          {t("runStatus.interrupted")}
        </StatusBadge>
      ) : last.outcome === "partial" ? (
        <StatusBadge tone="warning" icon={TriangleAlert} className="whitespace-nowrap">
          {t("list.backupPartial")}
        </StatusBadge>
      ) : null}
    </div>
  );
}

/** The person a machine is assigned to, or that it is assigned to nobody. */
function AssigneeCell({ endpoint }: { endpoint: EndpointSummary }) {
  const { t } = useTranslation("endpoints");
  const person = endpoint.assignedTo;
  if (!person) {
    return <span className="text-muted-foreground">{t("list.assignedNobody")}</span>;
  }
  return (
    <div className="min-w-0" title={person.email}>
      <span className="block truncate">{assigneeName(person)}</span>
      {person.displayName ? (
        <span className="block truncate text-xs text-muted-foreground">{person.email}</span>
      ) : null}
    </div>
  );
}

/**
 * Servers, clients or every machine with an agent: name, system, connection,
 * last backup, last contact, the rating of the newest backup, the backup job
 * (or that the machine is without backup), the person it is assigned to and what
 * needs attention. The agents list adds the profile and the agent version.
 *
 * Every row has its actions in the "…" menu and as the context menu of the row
 * (right click, the context menu key, Shift+F10): open the machine, back it up now,
 * restore its files, assign it to a person; administrators of jobs also create a job
 * for a machine without backup or add it to one. They can select machines and make a
 * new job from the selection, or add the selection to a job.
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
}: EndpointsTableProps) {
  const { t } = useTranslation("endpoints");
  const showAgentColumns = area === "agents";
  const [adding, setAdding] = React.useState<JobCandidate[] | null>(null);
  const [assigning, setAssigning] = React.useState<AssignTarget | null>(null);
  const jobsAccess = useJobsAccess();
  const assignAccess = useAssignAccess();
  const backup = useBackupNow();
  const requestBackup = backup.request;
  const jobActions = useJobActions();
  const runJobNow = jobActions.runNow;
  const runningJobs = jobActions.running;

  const columns = React.useMemo<ColumnDef<EndpointSummary>[]>(() => {
    const list: ColumnDef<EndpointSummary>[] = [
      {
        id: "name",
        // Pinned (see `pinnedColumns`): the width is fixed.
        size: 288,
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
          const hostLine = endpointHostLine(endpoint);
          return (
            <Dimmed revoked={endpoint.status === "revoked"}>
              <div className="flex min-w-0 items-start gap-2">
                <ProfileIcon profile={endpoint.profile} className="mt-0.5" />
                <div className="min-w-0">
                  <Link
                    to={endpointDetailTo(endpoint.id)}
                    className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    title={endpointName(endpoint)}
                  >
                    {endpointName(endpoint)}
                  </Link>
                  {hostLine ? (
                    <p className="truncate text-xs text-muted-foreground" title={hostLine}>
                      {hostLine}
                    </p>
                  ) : null}
                </div>
              </div>
            </Dimmed>
          );
        },
      },
    ];

    if (showAgentColumns) {
      list.push({
        id: "profile",
        size: 110,
        accessorFn: (endpoint) => endpoint.profile,
        header: t("list.columns.profile"),
        meta: { label: t("list.columns.profile"), className: "hidden 2xl:table-cell" },
        filterFn: matchesAnyOf,
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <ProfileBadge profile={row.original.profile} />
          </Dimmed>
        ),
      });
    }

    list.push(
      {
        id: "system",
        size: 150,
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
        id: "status",
        size: 150,
        accessorFn: (endpoint) => (endpoint.status === "revoked" ? "revoked" : endpoint.connection),
        header: t("list.columns.status"),
        meta: { label: t("list.columns.status") },
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <ConnectionBadge endpoint={row.original} />
            <ActivityBadge endpoint={row.original} />
          </div>
        ),
      },
      {
        id: "readiness",
        size: 150,
        accessorFn: (endpoint) => endpoint.readiness.state,
        header: t("list.columns.readiness"),
        meta: { label: t("list.columns.readiness"), headerClassName: "whitespace-nowrap" },
        filterFn: matchesAnyOf,
        sortingFn: (a, b) =>
          READINESS_RANK[a.original.readiness.state] - READINESS_RANK[b.original.readiness.state],
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <ReadinessBadge
              readiness={row.original.readiness}
              withoutBackup={isWithoutBackup(row.original)}
            />
          </Dimmed>
        ),
      },
      {
        id: "lastBackup",
        size: 150,
        accessorFn: (endpoint) => timeValue(endpoint.lastBackupAt),
        enableGlobalFilter: false,
        header: t("list.columns.lastBackup"),
        meta: { label: t("list.columns.lastBackup"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <LastBackupCell endpoint={row.original} />
          </Dimmed>
        ),
      },
      {
        id: "lastSeen",
        size: 130,
        accessorFn: (endpoint) => timeValue(endpoint.lastSeenAt),
        enableGlobalFilter: false,
        header: t("list.columns.lastSeen"),
        meta: {
          label: t("list.columns.lastSeen"),
          className: "hidden xl:table-cell",
          headerClassName: "whitespace-nowrap",
        },
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
        size: 170,
        accessorFn: jobFilterValue,
        enableGlobalFilter: false,
        header: t("list.columns.job"),
        meta: { label: t("list.columns.job"), headerClassName: "whitespace-nowrap" },
        filterFn: matchesAnyOf,
        sortingFn: (a, b) =>
          (a.original.job?.name ?? "").localeCompare(b.original.job?.name ?? "", undefined, {
            sensitivity: "base",
            numeric: true,
          }),
        cell: ({ row }) => (
          <Dimmed revoked={row.original.status === "revoked"}>
            <JobCell endpoint={row.original} />
          </Dimmed>
        ),
      },
      {
        id: "assignedTo",
        size: 180,
        accessorFn: assigneeFilterValue,
        enableGlobalFilter: false,
        header: t("list.columns.assignedTo"),
        meta: {
          label: t("list.columns.assignedTo"),
          headerClassName: "whitespace-nowrap",
          className: "hidden lg:table-cell",
        },
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
            <AssigneeCell endpoint={row.original} />
          </Dimmed>
        ),
      },
      {
        id: "attention",
        size: 200,
        accessorFn: (endpoint) => otherAttention(endpoint.attention).length,
        enableGlobalFilter: false,
        header: t("list.columns.attention"),
        meta: { label: t("list.columns.attention"), cellClassName: "max-w-64" },
        cell: ({ row }) => (
          <AttentionBadges attention={otherAttention(row.original.attention)} max={2} />
        ),
      },
    );

    if (showAgentColumns) {
      list.push({
        id: "agentVersion",
        size: 120,
        accessorFn: (endpoint) => endpoint.agentVersion ?? "",
        header: t("list.columns.agentVersion"),
        meta: {
          label: t("list.columns.agentVersion"),
          className: "hidden 2xl:table-cell",
          headerClassName: "whitespace-nowrap",
        },
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
    list.push(
      rowActionsColumn<EndpointSummary>({
        name: endpointName,
        actions: (endpoint): RowAction[] => {
          const name = endpointName(endpoint);
          const revoked = endpoint.status === "revoked";
          const withoutBackup = isWithoutBackup(endpoint);
          const actions: RowAction[] = [
            {
              id: "open",
              label: t("list.rowActions.open"),
              icon: FolderOpen,
              link: { to: endpointDetailTo(endpoint.id) },
            },
            {
              id: "backup",
              label: t("actions.backup.label"),
              icon: Play,
              // Backups run only in a backup job; the server refuses the request otherwise (409).
              disabled: revoked || withoutBackup,
              reason: revoked
                ? t("list.rowActions.revoked")
                : withoutBackup
                  ? t("actions.backup.needsJob")
                  : undefined,
              onSelect: () => requestBackup(endpoint.id),
            },
            {
              id: "restore",
              label: t("list.rowActions.restoreFiles"),
              icon: FolderSearch,
              disabled: endpoint.readiness.latestSnapshotId === null,
              reason:
                endpoint.readiness.latestSnapshotId === null
                  ? t("list.rowActions.noRestorePoint")
                  : undefined,
              link: fileRestoreTo(endpoint.id),
            },
          ];
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
            disabled: revoked || assignAccess.closed,
            reason: revoked ? t("list.rowActions.revoked") : assignAccess.reason,
            onSelect: () =>
              setAssigning({ id: endpoint.id, name, assignedTo: endpoint.assignedTo ?? null }),
          });
          return actions;
        },
        selectionActions: canManageJobs
          ? (selected): RowAction[] => {
              const active = selected.filter((endpoint) => endpoint.status === "active");
              // Only a machine in a job can be backed up (release 0.2.1); one request per job.
              const inJob = active.filter((endpoint) => endpoint.job);
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
                  label: t("list.rowActions.newJobFromSelection", { count: active.length }),
                  icon: ListPlus,
                  disabled: jobsAccess.closed || active.length === 0,
                  reason: jobsClosed,
                  link: newJobTo(
                    "endpoint",
                    active.map((endpoint) => endpoint.id),
                  ),
                },
                {
                  id: "addSelectionToJob",
                  label: t("list.rowActions.addSelectionToJob", { count: active.length }),
                  icon: ListChecks,
                  disabled: jobsAccess.closed || active.length === 0,
                  reason: jobsClosed,
                  onSelect: () => setAdding(active.map(candidate)),
                },
              ];
            }
          : undefined,
      }) as ColumnDef<EndpointSummary>,
    );
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
  ]);

  const present = new Set((items ?? []).map((endpoint) => endpoint.readiness.state));
  const readinessOptions = READINESS_ORDER.filter((state) => present.has(state)).map((state) => ({
    value: state,
    label: t(`readiness.state.${state}`),
  }));
  const profilesPresent = new Set((items ?? []).map((endpoint) => endpoint.profile));
  const profileOptions = (["server", "client"] as const)
    .filter((profile) => profilesPresent.has(profile))
    .map((profile) => ({ value: profile, label: t(`profile.${profile}`) }));
  const jobValues = new Set((items ?? []).map(jobFilterValue));
  const jobOptions = JOB_FILTER_ORDER.filter((value) => jobValues.has(value)).map((value) => ({
    value,
    label: t(`list.jobFilter.${value}`),
  }));
  const assigneeOptions = assigneeFilterOptions(items ?? [], t("list.assignedNobody"));

  return (
    <>
      <DataTable
        id={`endpoints-${area}`}
        label={t(`areas.${area}.title`)}
        columns={columns}
        data={items}
        getRowId={(endpoint) => endpoint.id}
        loading={loading}
        fetching={fetching}
        error={error}
        onRetry={onRetry}
        errorTitle={t("list.errors.load")}
        empty={empty}
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
            {readinessOptions.length > 1 ? (
              <DataTableFacetedFilter
                title={t("list.columns.readiness")}
                options={readinessOptions}
                column={table.getColumn("readiness")}
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
          </>
        )}
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
