import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  DataTable,
  DataTableFacetedFilter,
  RelativeTime,
  StatusBadge,
  matchesAnyOf,
  rowActionsColumn,
} from "@/components/kit";
import { Switch } from "@/components/ui/switch";
import { jobDetailTo } from "@/features/jobs/paths";

import type { ScheduleItem, ScheduleKind } from "../api.js";
import {
  JOB_REPLACED_KINDS,
  JOB_STATUS_TONE,
  KIND_ICON,
  describeCadence,
  describeScope,
  lastActivityAt,
  usesTimeZone,
} from "../presenters.js";

export interface SchedulesTableProps {
  items: readonly ScheduleItem[] | undefined;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  canManage: boolean;
  /** Shown instead of the table body when the tenant has no schedules. */
  empty: React.ReactNode;
  onEdit: (item: ScheduleItem) => void;
  onDelete: (item: ScheduleItem) => void;
  onToggle: (item: ScheduleItem, enabled: boolean) => void;
  /** Id of the schedule whose switch is being saved. */
  pendingId: string | null;
}

const KIND_ORDER: readonly ScheduleKind[] = [
  "backup",
  "verify",
  "scrub",
  "directory",
  "retention",
  "archive",
];

/** The schedule kind stays in view while the other columns scroll. */
const PINNED = ["kind"] as const;

/** Every schedule of the tenant: what, for whom, how often, when next and how it went last. */
export function SchedulesTable({
  items,
  loading,
  fetching,
  error,
  onRetry,
  canManage,
  empty,
  onEdit,
  onDelete,
  onToggle,
  pendingId,
}: SchedulesTableProps) {
  const { t, i18n } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;

  const columns = React.useMemo<ColumnDef<ScheduleItem>[]>(() => {
    const kindLabel = (kind: ScheduleKind) => t(`kinds.${kind}`);
    const list: ColumnDef<ScheduleItem>[] = [
      {
        id: "kind",
        size: 200,
        accessorKey: "kind",
        header: t("table.kind"),
        meta: { label: t("table.kind") },
        filterFn: matchesAnyOf,
        enableHiding: false,
        sortingFn: (a, b) =>
          KIND_ORDER.indexOf(a.original.kind) - KIND_ORDER.indexOf(b.original.kind),
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge
              tone={row.original.enabled ? "info" : "muted"}
              icon={KIND_ICON[row.original.kind]}
            >
              {kindLabel(row.original.kind)}
            </StatusBadge>
            {JOB_REPLACED_KINDS.includes(row.original.kind) ? (
              <span className="text-xs text-muted-foreground">{t("table.legacy")}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: "scope",
        size: 180,
        accessorFn: (item) => describeScope(item, t),
        header: t("table.scope"),
        meta: { label: t("table.scope"), cellClassName: "max-w-56 truncate" },
        cell: ({ getValue }) => <span title={String(getValue())}>{String(getValue())}</span>,
      },
      {
        id: "cadence",
        size: 180,
        accessorFn: (item) => describeCadence(item, t, language),
        header: t("table.cadence"),
        meta: { label: t("table.cadence") },
        enableSorting: false,
        cell: ({ row, getValue }) => (
          <div className="min-w-0">
            <div>{String(getValue())}</div>
            {usesTimeZone(row.original) ? (
              <div className="text-xs text-muted-foreground">{row.original.timezone}</div>
            ) : null}
          </div>
        ),
      },
      {
        id: "nextRun",
        size: 130,
        accessorFn: (item) => (item.enabled ? (item.nextRunAt ?? undefined) : undefined),
        sortUndefined: "last",
        header: t("table.nextRun"),
        meta: { label: t("table.nextRun"), headerClassName: "whitespace-nowrap" },
        cell: ({ row }) =>
          row.original.enabled ? (
            <RelativeTime value={row.original.nextRunAt} focusable={false} />
          ) : (
            <span className="text-muted-foreground">{t("table.paused")}</span>
          ),
      },
      {
        id: "lastRun",
        size: 130,
        accessorFn: (item) => lastActivityAt(item) ?? undefined,
        sortUndefined: "last",
        header: t("table.lastRun"),
        meta: {
          label: t("table.lastRun"),
          className: "hidden md:table-cell",
          headerClassName: "whitespace-nowrap",
        },
        cell: ({ row }) => <RelativeTime value={lastActivityAt(row.original)} focusable={false} />,
      },
      {
        id: "lastJob",
        size: 130,
        accessorFn: (item) => item.lastJob?.status,
        header: t("table.lastJob"),
        meta: {
          label: t("table.lastJob"),
          className: "hidden lg:table-cell",
          headerClassName: "whitespace-nowrap",
        },
        enableSorting: false,
        cell: ({ row }) => {
          const job = row.original.lastJob;
          if (!job) {
            return <span className="text-muted-foreground">{t("table.noJob")}</span>;
          }
          const badge = (
            <StatusBadge
              tone={JOB_STATUS_TONE[job.status]}
              icon={job.status !== "active"}
              live={job.status === "active"}
            >
              {t(`jobStatus.${job.status}`)}
            </StatusBadge>
          );
          // The job pages are for administrators; tenant users see the outcome only.
          if (!canManage || job.id === null) {
            return badge;
          }
          return (
            <Link
              to={jobDetailTo(job.id)}
              className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              aria-label={t("table.openJob", { status: t(`jobStatus.${job.status}`) })}
            >
              {badge}
            </Link>
          );
        },
      },
      {
        id: "enabled",
        size: 100,
        accessorKey: "enabled",
        header: t("table.enabled"),
        meta: { label: t("table.enabled") },
        cell: ({ row }) => (
          <Switch
            checked={row.original.enabled}
            disabled={!canManage || pendingId === row.original.id}
            onCheckedChange={(checked) => onToggle(row.original, checked)}
            aria-label={t("table.toggle", { kind: kindLabel(row.original.kind) })}
          />
        ),
      },
    ];
    if (canManage) {
      list.push(
        rowActionsColumn<ScheduleItem>({
          // Two backup schedules differ by scope: name both, so each menu is identifiable.
          name: (item) => `${kindLabel(item.kind)} · ${describeScope(item, t)}`,
          actions: (item) => [
            { id: "edit", label: t("actions.edit"), icon: Pencil, onSelect: () => onEdit(item) },
            {
              id: "delete",
              label: t("actions.delete"),
              icon: Trash2,
              destructive: true,
              onSelect: () => onDelete(item),
            },
          ],
        }) as ColumnDef<ScheduleItem>,
      );
    }
    return list;
  }, [t, language, canManage, pendingId, onEdit, onDelete, onToggle]);

  const kindsPresent = new Set((items ?? []).map((item) => item.kind));
  const kindOptions = KIND_ORDER.filter((kind) => kindsPresent.has(kind)).map((kind) => ({
    value: kind,
    label: t(`kinds.${kind}`),
    icon: KIND_ICON[kind],
  }));

  return (
    <DataTable
      id="schedules"
      label={t("table.label")}
      columns={columns}
      data={items}
      getRowId={(item) => item.id}
      loading={loading}
      fetching={fetching}
      error={error}
      onRetry={onRetry}
      errorTitle={t("errors.load")}
      empty={empty}
      pinnedColumns={PINNED}
      sorting={{ mode: "client", initial: [{ id: "kind", desc: false }] }}
      pagination={{ mode: "client", pageSize: 25 }}
      toolbar={(table) =>
        kindOptions.length > 1 ? (
          <DataTableFacetedFilter
            title={t("table.kind")}
            options={kindOptions}
            column={table.getColumn("kind")}
          />
        ) : null
      }
    />
  );
}
