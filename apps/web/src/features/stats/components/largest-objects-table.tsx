import { useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Inbox, Layers, MailSearch } from "lucide-react";
import * as React from "react";

import {
  DataTable,
  DataTableFacetedFilter,
  DataTableSearch,
  EmptyState,
  type FacetOption,
  RelativeTime,
  StatusBadge,
  matchesAnyOf,
  rowActionsColumn,
} from "@/components/kit";
import { directoryPath } from "@/features/directory/search";
import { RESTORE_PATHS } from "@/features/restore/navigation";
import { useSession } from "@/lib/session";

import type { Dataset, LargestObjectRow } from "../api.js";
import { objectStateTone } from "../presenters.js";
import { useStatsFormat } from "../use-stats-format.js";
import { MISSING_LAST, TableCard, rowsOf } from "./table-card.js";

/** The object stays in view while the other columns scroll. */
const PINNED = ["name"] as const;

interface LargestObjectsTableProps {
  data: Dataset<LargestObjectRow> | undefined;
}

/**
 * The protected objects that take the most space (logical, before
 * deduplication), with the way into their backups and their entry in the
 * protected-objects list. In the provider scope each row names its tenant,
 * and the ways in first switch to that tenant.
 */
export function LargestObjectsTable({ data }: LargestObjectsTableProps) {
  const format = useStatsFormat();
  const { t } = format;
  const navigate = useNavigate();
  const { activeTenant, setActiveTenant } = useSession();
  const title = t("tables.largest.title");
  const rows = rowsOf(data);
  const showTenant = (rows ?? []).some((row) => row.tenant !== null);
  const activeTenantId = activeTenant?.id ?? null;

  const openIn = React.useCallback(
    (row: LargestObjectRow, to: string, search: Record<string, string>) => {
      if (row.tenant && row.tenant.id !== activeTenantId) {
        setActiveTenant(row.tenant.id);
      }
      void navigate({ to: to as never, search: search as never });
    },
    [activeTenantId, setActiveTenant, navigate],
  );

  const kindOptions = React.useMemo<FacetOption[]>(() => {
    const kinds = [...new Set((rows ?? []).map((row) => row.kind))].sort();
    return kinds.map((kind) => ({ value: kind, label: format.objectKind(kind) }));
  }, [rows, format]);

  const columns = React.useMemo<ColumnDef<LargestObjectRow, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        size: 288,
        header: t("tables.largest.columns.name"),
        enableHiding: false,
        meta: { cellClassName: "font-medium" },
        cell: ({ row }) => <span title={row.original.name}>{row.original.name}</span>,
      },
      ...(showTenant
        ? [
            {
              id: "tenant",
              size: 180,
              accessorFn: (row: LargestObjectRow) => row.tenant?.name ?? undefined,
              header: t("tables.largest.columns.tenant"),
              ...MISSING_LAST,
              meta: { className: "hidden md:table-cell", cellClassName: "max-w-48 truncate" },
            } satisfies ColumnDef<LargestObjectRow, unknown>,
          ]
        : []),
      {
        accessorKey: "kind",
        size: 130,
        header: t("tables.largest.columns.kind"),
        filterFn: matchesAnyOf,
        enableGlobalFilter: false,
        cell: ({ row }) => format.objectKind(row.original.kind),
      },
      {
        accessorKey: "logicalBytes",
        size: 130,
        header: t("tables.largest.columns.logicalBytes"),
        enableGlobalFilter: false,
        meta: { numeric: true },
        cell: ({ row }) => format.bytes(row.original.logicalBytes),
      },
      {
        id: "lastBackupAt",
        size: 150,
        accessorFn: (row) => row.lastBackupAt ?? undefined,
        header: t("tables.largest.columns.lastBackupAt"),
        ...MISSING_LAST,
        enableGlobalFilter: false,
        meta: { className: "hidden md:table-cell whitespace-nowrap" },
        cell: ({ row }) => <RelativeTime value={row.original.lastBackupAt} focusable={false} />,
      },
      {
        id: "state",
        size: 150,
        accessorFn: (row) => row.state ?? undefined,
        header: t("tables.largest.columns.state"),
        ...MISSING_LAST,
        enableGlobalFilter: false,
        meta: { className: "hidden lg:table-cell" },
        cell: ({ row }) => (
          <StatusBadge tone={objectStateTone(row.original.state)}>
            {format.objectState(row.original.state)}
          </StatusBadge>
        ),
      },
      rowActionsColumn<LargestObjectRow>({
        name: (row) => row.name,
        actions: (row) => [
          {
            id: "browse",
            label: t("tables.largest.actions.browse"),
            icon: MailSearch,
            onSelect: () => openIn(row, RESTORE_PATHS.explorer, { object: row.id }),
          },
          {
            id: "object",
            label: t("tables.largest.actions.object"),
            icon: Layers,
            onSelect: () => openIn(row, directoryPath(), { q: row.name }),
          },
        ],
      }),
    ],
    [t, format, showTenant, openIn],
  );

  return (
    <TableCard
      title={title}
      description={t("tables.largest.description")}
      name="largestObjects"
      data={data}
    >
      <DataTable
        id="stats.largest-objects"
        label={title}
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        loading={data === undefined}
        sorting={{ mode: "client", initial: [{ id: "logicalBytes", desc: true }] }}
        pagination={{ mode: "client", pageSize: 10, pageSizes: [10, 25, 50] }}
        maxHeight="none"
        pinnedColumns={PINNED}
        toolbar={(table) => (
          <>
            <DataTableSearch
              value={String(table.getState().globalFilter ?? "")}
              onChange={(value) => table.setGlobalFilter(value)}
              placeholder={t("tables.largest.search")}
            />
            {kindOptions.length > 1 ? (
              <DataTableFacetedFilter
                title={t("tables.largest.columns.kind")}
                options={kindOptions}
                column={table.getColumn("kind")}
              />
            ) : null}
          </>
        )}
        empty={
          <EmptyState
            variant="plain"
            icon={Inbox}
            title={t("tables.largest.empty.title")}
            description={t("tables.largest.empty.description")}
          />
        }
      />
    </TableCard>
  );
}
