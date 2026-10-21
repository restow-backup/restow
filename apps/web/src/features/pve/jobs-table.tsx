import type { ColumnDef } from "@tanstack/react-table";
import { CalendarClock, Pencil, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, EmptyState, rowActionsColumn } from "@/components/kit";
import { describeCadence } from "@/features/schedules/presenters";
import { formatDateTime } from "@/lib/format";

import type { PveJob } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { cadenceOfPveSchedule } from "./schedule.js";

/**
 * The backup jobs of VMs & containers: one line per job in a table whose columns keep their
 * width while a round runs (its progress has a column of its own, cut to one line). Edit and
 * delete are in the row's menu; the name opens the editor.
 */

export const JOB_COLUMN_SIZES = {
  name: 260,
  guests: 110,
  schedule: 220,
  nextRun: 170,
  round: 200,
  actions: 48,
} as const;

export function JobsTable({
  jobs,
  loading = false,
  onEdit,
  onDelete,
}: {
  jobs: readonly PveJob[] | undefined;
  loading?: boolean;
  onEdit: (job: PveJob) => void;
  onDelete: (job: PveJob) => void;
}) {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const columns = React.useMemo<ColumnDef<PveJob>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: t("jobs.name"),
        size: JOB_COLUMN_SIZES.name,
        meta: { label: t("jobs.name") },
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => onEdit(row.original)}
            title={row.original.name}
            className="max-w-full truncate rounded-sm text-left font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {row.original.name}
          </button>
        ),
      },
      {
        id: "guests",
        accessorFn: (job) => job.guestCount ?? 0,
        header: t("jobs.guestCount"),
        size: JOB_COLUMN_SIZES.guests,
        meta: { label: t("jobs.guestCount"), numeric: true },
        cell: ({ row }) => (
          <span title={row.original.scopeAll ? t("jobs.scopeAll") : t("jobs.scopeSelected")}>
            {row.original.guestCount ?? 0}
            {row.original.scopeAll ? <span className="text-muted-foreground"> *</span> : null}
          </span>
        ),
      },
      {
        id: "schedule",
        accessorFn: (job) => job.nextRunAt ?? "",
        header: t("jobs.schedule"),
        size: JOB_COLUMN_SIZES.schedule,
        enableSorting: false,
        meta: { label: t("jobs.schedule") },
        cell: ({ row }) => {
          const text = row.original.schedule
            ? describeCadence(cadenceOfPveSchedule(row.original.schedule), tSchedules, language)
            : t("jobs.manualOnly");
          return <span title={text}>{text}</span>;
        },
      },
      {
        id: "nextRun",
        accessorFn: (job) => job.nextRunAt ?? "",
        header: t("jobs.nextRun"),
        size: JOB_COLUMN_SIZES.nextRun,
        meta: { label: t("jobs.nextRun") },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatDateTime(row.original.nextRunAt, language) ?? ""}
          </span>
        ),
      },
      {
        id: "round",
        header: t("jobs.round"),
        size: JOB_COLUMN_SIZES.round,
        enableSorting: false,
        meta: { label: t("jobs.round") },
        cell: ({ row }) => {
          const round = row.original.round;
          if (!round) {
            return <span className="text-muted-foreground">{t("jobs.roundIdle")}</span>;
          }
          const text = t("jobs.roundProgress", {
            done: round.done,
            total: round.total,
            failed: round.failed,
          });
          return (
            <span className="tabular-nums" title={text} data-slot="pve-job-round">
              {text}
            </span>
          );
        },
      },
      rowActionsColumn<PveJob>({
        name: (job) => job.name,
        actions: (job) => [
          { id: "edit", label: t("jobs.edit"), icon: Pencil, onSelect: () => onEdit(job) },
          {
            id: "delete",
            label: t("jobs.delete"),
            icon: Trash2,
            destructive: true,
            onSelect: () => onDelete(job),
          },
        ],
      }),
    ],
    [t, tSchedules, language, onEdit, onDelete],
  );
  return (
    <DataTable<PveJob>
      id="pve-jobs"
      label={t("jobs.title")}
      columns={columns}
      data={jobs}
      getRowId={(job) => job.id}
      loading={loading}
      fixedLayout
      skeletonRows={3}
      maxHeight="none"
      columnsMenu={false}
      sorting={{ mode: "client", initial: [{ id: "name", desc: false }] }}
      onRowClick={onEdit}
      empty={<EmptyState variant="plain" icon={CalendarClock} title={t("jobs.empty")} />}
    />
  );
}
