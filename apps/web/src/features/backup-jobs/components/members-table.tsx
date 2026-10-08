import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { DatabaseBackup, ListPlus, Pencil, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  DataTable,
  DataTableSearch,
  RelativeTime,
  type RowAction,
  StatusBadge,
  rowActionsColumn,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { directoryTo } from "@/features/directory/search";
import { endpointDetailTo } from "@/features/endpoints/paths";
import { StateBadge } from "@/features/verify/components/status";
import { cn } from "@/lib/utils";

import type { BackupJob, JobMember } from "../api.js";
import { overrideGroupsSet } from "../form.js";
import {
  MEMBER_KIND_ICON,
  describeJobSchedule,
  memberOutcomeTone,
  pendingBackupView,
} from "../presenters.js";
import { type JobsAccess, closedProps } from "./access-note.js";

export interface MembersTableProps {
  job: BackupJob;
  items: readonly JobMember[] | undefined;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  empty: React.ReactNode;
  access: JobsAccess;
  /** Adding and removing apply to a job that names its objects; an "all" job covers what no other job has. */
  canChangeScope: boolean;
  onAdd: () => void;
  onEditOverrides: (member: JobMember) => void;
  onRun: (member: JobMember) => void;
  onRemove: (member: JobMember) => void;
}

const PINNED = ["name"] as const;

function timeValue(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** What a requested backup waits for: the machine's next check-in, or its start on the machine. */
function PendingBackupNote({ pending }: { pending: NonNullable<JobMember["pendingBackup"]> }) {
  const { t } = useTranslation("backupjobs");
  const view = pendingBackupView(pending, Date.now());
  return (
    <span className="max-w-48 text-xs text-muted-foreground">
      {view.kind === "starting"
        ? t("scope.queued.starting")
        : view.kind === "waiting"
          ? t("scope.queued.waiting", { count: view.minutes })
          : t("scope.queued.due")}
    </span>
  );
}

type Translate = (key: string, options?: { defaultValue?: string }) => string;

/** A machine's operating system in words ("macOS"); a mailbox's address as it is. */
export function memberDetail(member: Pick<JobMember, "kind" | "detail">, t: Translate): string {
  const machine = member.kind === "server" || member.kind === "client";
  if (!member.detail || !machine) {
    return member.detail ?? "";
  }
  return t(`endpoints:os.${member.detail}`, { defaultValue: member.detail });
}

/** Why a member is not backed up, in words ("Ausgeschlossen", "Gesperrt"), never the raw code. */
export function memberStatusWord(member: Pick<JobMember, "kind" | "status">, t: Translate): string {
  const machine = member.kind === "server" || member.kind === "client";
  const key = machine ? `endpoints:status.${member.status}` : `directory:status.${member.status}`;
  return t(key, { defaultValue: member.status });
}

/**
 * The objects or machines a job covers, with what each does now: its schedule
 * (the job's, or its own), its newest backup, its restore check and what it does
 * differently. Search, "Add", and per row: edit overrides, run now, remove.
 */
export function MembersTable({
  job,
  items,
  loading,
  fetching,
  error,
  onRetry,
  empty,
  access,
  canChangeScope,
  onAdd,
  onEditOverrides,
  onRun,
  onRemove,
}: MembersTableProps) {
  const { t, i18n } = useTranslation("backupjobs");
  const { t: tSchedules } = useTranslation("schedules");
  const { t: tc } = useTranslation(["directory", "endpoints"]);
  const language = i18n.resolvedLanguage ?? i18n.language;

  const columns = React.useMemo<ColumnDef<JobMember>[]>(() => {
    const ctx = { t, tSchedules, language };
    return [
      {
        id: "name",
        size: 270,
        accessorFn: (member) => `${member.name} ${member.detail ?? ""}`,
        header: t("scope.columns.name"),
        meta: { label: t("scope.columns.name") },
        enableHiding: false,
        sortingFn: (a, b) =>
          a.original.name.localeCompare(b.original.name, undefined, {
            sensitivity: "base",
            numeric: true,
          }),
        cell: ({ row }) => {
          const member = row.original;
          const Icon = MEMBER_KIND_ICON[member.kind];
          const machine = member.kind === "server" || member.kind === "client";
          return (
            <div className={cn("flex min-w-0 items-start gap-2", !member.covered && "opacity-70")}>
              <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                {machine ? (
                  <Link
                    to={endpointDetailTo(member.targetId)}
                    className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    title={member.name}
                  >
                    {member.name}
                  </Link>
                ) : (
                  <Link
                    to={directoryTo()}
                    search={{ q: member.detail ?? member.name } as never}
                    className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    title={member.name}
                  >
                    {member.name}
                  </Link>
                )}
                {member.detail ? (
                  <span
                    className="block truncate text-xs text-muted-foreground"
                    title={member.detail}
                  >
                    {memberDetail(member, tc)}
                  </span>
                ) : null}
                {!member.covered ? (
                  <span className="block text-xs text-muted-foreground">
                    {t("scope.notCovered", { status: memberStatusWord(member, tc) })}
                  </span>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        id: "kind",
        size: 110,
        accessorFn: (member) => member.kind,
        enableGlobalFilter: false,
        header: t("scope.columns.kind"),
        // The icon in front of the name says it already; the column is for wide screens.
        meta: { label: t("scope.columns.kind"), className: "hidden 2xl:table-cell" },
        cell: ({ row }) => <span>{t(`scope.kindNames.${row.original.kind}`)}</span>,
      },
      {
        id: "schedule",
        size: 190,
        enableSorting: false,
        enableGlobalFilter: false,
        accessorFn: (member) => member.effective.schedule?.kind ?? "",
        header: t("scope.columns.schedule"),
        meta: { label: t("scope.columns.schedule") },
        cell: ({ row }) => {
          const own = row.original.overrides.schedule !== undefined;
          return (
            <div className="min-w-0">
              <div>{describeJobSchedule(row.original.effective.schedule, ctx)}</div>
              {own ? (
                <div className="text-xs text-muted-foreground">{t("scope.ownSchedule")}</div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "lastBackup",
        size: 150,
        accessorFn: (member) => timeValue(member.lastBackup.at),
        enableGlobalFilter: false,
        header: t("scope.columns.lastBackup"),
        meta: { label: t("scope.columns.lastBackup"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) => {
          const { at, outcome } = row.original.lastBackup;
          const pending = row.original.pendingBackup;
          const tone = memberOutcomeTone(outcome);
          return (
            <div className="flex flex-col items-start gap-1">
              {at ? (
                <RelativeTime value={at} focusable={false} />
              ) : (
                <span className="text-muted-foreground">{t("lastRun.never")}</span>
              )}
              {tone && outcome ? (
                <StatusBadge tone={tone} live={outcome === "running"} className="whitespace-nowrap">
                  {t(`scope.outcome.${outcome}`)}
                </StatusBadge>
              ) : null}
              {pending && outcome === "queued" ? <PendingBackupNote pending={pending} /> : null}
            </div>
          );
        },
      },
      {
        id: "restoreCheck",
        size: 160,
        accessorFn: (member) => member.restoreCheck.state,
        enableGlobalFilter: false,
        header: t("scope.columns.restoreCheck"),
        meta: { label: t("scope.columns.restoreCheck"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) => <StateBadge state={row.original.restoreCheck.state} />,
      },
      {
        id: "overrides",
        size: 190,
        accessorFn: (member) => overrideGroupsSet(member.overrides).length,
        enableGlobalFilter: false,
        header: t("scope.columns.overrides"),
        meta: { label: t("scope.columns.overrides") },
        cell: ({ row }) => {
          const groups = overrideGroupsSet(row.original.overrides);
          if (groups.length === 0) {
            return <span className="text-muted-foreground">{t("scope.noOverrides")}</span>;
          }
          const names = groups.map((group) => t(`overrides.groups.${group}.short`)).join(", ");
          return (
            <StatusBadge
              tone="neutral"
              title={names}
              className="whitespace-normal"
              data-overrides={groups.length}
            >
              {groups.length === 1 ? names : t("scope.overridesBadge", { count: groups.length })}
            </StatusBadge>
          );
        },
      },
      rowActionsColumn<JobMember>({
        name: (member) => member.name,
        describedBy: access.closed ? access.noteId : undefined,
        actions: (member): RowAction[] => {
          const describedBy = access.closed ? access.noteId : undefined;
          const actions: RowAction[] = [
            {
              id: "overrides",
              label: t("scope.actions.editOverrides"),
              icon: Pencil,
              disabled: access.closed,
              describedBy,
              onSelect: () => onEditOverrides(member),
            },
            {
              id: "run",
              label: t("actions.runNow"),
              icon: DatabaseBackup,
              disabled: access.closed || !member.covered,
              describedBy,
              onSelect: () => onRun(member),
            },
          ];
          if (canChangeScope) {
            actions.push({
              id: "remove",
              label: t("scope.actions.remove"),
              icon: Trash2,
              destructive: true,
              disabled: access.closed,
              describedBy,
              onSelect: () => onRemove(member),
            });
          }
          return actions;
        },
      }) as ColumnDef<JobMember>,
    ];
  }, [
    t,
    tSchedules,
    tc,
    language,
    access.closed,
    access.noteId,
    canChangeScope,
    onEditOverrides,
    onRun,
    onRemove,
  ]);

  return (
    <DataTable
      id={`backup-job-members-${job.kind}`}
      label={t(`scope.table.${job.kind}`)}
      columns={columns}
      data={items}
      getRowId={(member) => member.targetId}
      loading={loading}
      fetching={fetching}
      error={error}
      onRetry={onRetry}
      errorTitle={t("scope.loadError")}
      empty={empty}
      pinnedColumns={PINNED}
      sorting={{ mode: "client", initial: [{ id: "name", desc: false }] }}
      pagination={{ mode: "client", pageSize: 25 }}
      toolbar={(table) => (
        <DataTableSearch
          value={String(table.getState().globalFilter ?? "")}
          onChange={(value) => table.setGlobalFilter(value)}
          placeholder={t(`scope.search.${job.kind}`)}
        />
      )}
      toolbarActions={
        canChangeScope ? (
          <Button
            variant="outline"
            size="sm"
            disabled={access.closed}
            onClick={onAdd}
            {...closedProps(access)}
          >
            <ListPlus aria-hidden="true" />
            {t("scope.actions.add")}
          </Button>
        ) : null
      }
    />
  );
}
