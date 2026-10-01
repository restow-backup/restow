import { useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { CircleCheck, Copy, History } from "lucide-react";
import * as React from "react";

import {
  DataTable,
  DataTableSearch,
  EmptyState,
  RelativeTime,
  copyToClipboard,
  rowActionsColumn,
} from "@/components/kit";
import { toast } from "@/components/ui/sonner";
import { historyTo } from "@/features/jobs/paths";

import type { Dataset, FailureCauseRow } from "../api.js";
import { useStatsFormat } from "../use-stats-format.js";
import { MISSING_LAST, TableCard, rowsOf } from "./table-card.js";

/** The server's cause for a failure the engine gave no reason for. */
const UNKNOWN_CAUSE = "unknown";

interface FailuresTableProps {
  data: Dataset<FailureCauseRow> | undefined;
}

/**
 * Items that could not be processed in the period, grouped by the reason
 * the source gave. The server folds reasons into causes ("Graph 404
 * ErrorItemNotFound"); they are shown as reported, searchable and copyable.
 */
export function FailuresTable({ data }: FailuresTableProps) {
  const format = useStatsFormat();
  const { t } = format;
  const navigate = useNavigate();
  const title = t("tables.failures.title");

  const columns = React.useMemo<ColumnDef<FailureCauseRow, unknown>[]>(
    () => [
      {
        accessorKey: "cause",
        header: t("tables.failures.columns.cause"),
        enableHiding: false,
        meta: { cellClassName: "min-w-64 max-w-xl whitespace-normal break-words" },
        cell: ({ row }) => (
          <span className="line-clamp-3">
            {row.original.cause === UNKNOWN_CAUSE
              ? t("tables.failures.unknownCause")
              : row.original.cause}
          </span>
        ),
      },
      {
        accessorKey: "count",
        header: t("tables.failures.columns.count"),
        meta: { numeric: true },
        cell: ({ row }) => format.integer(row.original.count),
      },
      {
        id: "lastAt",
        accessorFn: (row) => row.lastAt ?? undefined,
        header: t("tables.failures.columns.lastAt"),
        ...MISSING_LAST,
        enableGlobalFilter: false,
        meta: { className: "hidden md:table-cell whitespace-nowrap" },
        cell: ({ row }) => (
          <RelativeTime
            value={row.original.lastAt}
            fallback={t("ui:time.unknown")}
            focusable={false}
          />
        ),
      },
      rowActionsColumn<FailureCauseRow>({
        name: (row) => row.cause,
        actions: (row) => [
          {
            id: "jobs",
            label: t("tables.failures.actions.jobs"),
            icon: History,
            onSelect: () => void navigate({ to: historyTo() }),
          },
          {
            id: "copy",
            label: t("tables.failures.actions.copy"),
            icon: Copy,
            onSelect: () => {
              copyToClipboard(row.cause).then(
                () => toast.success(t("tables.failures.copied")),
                () => toast.error(t("ui:copy.failed")),
              );
            },
          },
        ],
      }),
    ],
    [t, format, navigate],
  );

  return (
    <TableCard
      title={title}
      description={t("tables.failures.description")}
      name="failuresByCause"
      data={data}
    >
      <DataTable
        id="stats.failures-by-cause"
        label={title}
        columns={columns}
        data={rowsOf(data)}
        getRowId={(row) => row.cause}
        loading={data === undefined}
        sorting={{ mode: "client", initial: [{ id: "count", desc: true }] }}
        pagination={{ mode: "client", pageSize: 10, pageSizes: [10, 25, 50] }}
        maxHeight="none"
        toolbar={(table) => (
          <DataTableSearch
            value={String(table.getState().globalFilter ?? "")}
            onChange={(value) => table.setGlobalFilter(value)}
            placeholder={t("tables.failures.search")}
          />
        )}
        empty={
          <EmptyState
            variant="plain"
            icon={CircleCheck}
            title={t("tables.failures.empty.title")}
            description={t("tables.failures.empty.description")}
          />
        }
      />
    </TableCard>
  );
}
