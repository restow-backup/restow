import { useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Building2, ChartColumn, Settings2 } from "lucide-react";
import * as React from "react";

import {
  DataTable,
  DataTableFacetedFilter,
  DataTableSearch,
  EmptyState,
  type FacetOption,
  StatusBadge,
  matchesAnyOf,
  rowActionsColumn,
} from "@/components/kit";
import { tenantDetailTo } from "@/features/tenants/paths";

import type { Dataset, TenantRow } from "../api.js";
import { readinessTone, runRateTone } from "../presenters.js";
import { useStatsFormat } from "../use-stats-format.js";
import { MISSING_LAST, TableCard, rowsOf } from "./table-card.js";

/** Filter value of a tenant without readiness: it protects nothing yet. */
const NOTHING_PROTECTED = "none";

/** Readiness values in the order a filter lists them. */
const READINESS_ORDER = ["green", "yellow", "red", "unverified"] as const;

interface TenantsTableProps {
  data: Dataset<TenantRow> | undefined;
  /** Switch to the tenant scope for this tenant. */
  onOpenTenantStats: (tenantId: string) => void;
}

/**
 * Provider scope: one row per tenant with its objects, success rate,
 * volume, readiness and failed items in the period, so the tenants that
 * need attention stand out; each row leads to that tenant's statistics.
 */
export function TenantsTable({ data, onOpenTenantStats }: TenantsTableProps) {
  const format = useStatsFormat();
  const { t } = format;
  const navigate = useNavigate();
  const title = t("tables.tenants.title");
  const rows = rowsOf(data);

  const readinessOptions = React.useMemo<FacetOption[]>(() => {
    const present = new Set((rows ?? []).map((row) => row.readiness ?? NOTHING_PROTECTED));
    const ordered = [
      ...READINESS_ORDER.filter((value) => present.has(value)),
      ...[...present].filter((value) => !(READINESS_ORDER as readonly string[]).includes(value)),
    ];
    return ordered.map((value) => ({
      value,
      label:
        value === NOTHING_PROTECTED
          ? t("tables.tenants.nothingProtected")
          : format.readiness(value),
    }));
  }, [rows, format, t]);

  const columns = React.useMemo<ColumnDef<TenantRow, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("tables.tenants.columns.name"),
        enableHiding: false,
        meta: { cellClassName: "max-w-64 truncate font-medium" },
        cell: ({ row }) => <span title={row.original.name}>{row.original.name}</span>,
      },
      {
        accessorKey: "objects",
        header: t("tables.tenants.columns.objects"),
        enableGlobalFilter: false,
        meta: { numeric: true },
        cell: ({ row }) => format.integer(row.original.objects),
      },
      {
        id: "successRate",
        accessorFn: (row) => row.successRate ?? undefined,
        header: t("tables.tenants.columns.successRate"),
        ...MISSING_LAST,
        enableGlobalFilter: false,
        meta: { numeric: true },
        cell: ({ row }) =>
          row.original.successRate === null ? (
            <span className="text-muted-foreground">{t("tables.tenants.noRuns")}</span>
          ) : (
            <StatusBadge tone={runRateTone(row.original.successRate)}>
              {format.share(row.original.successRate)}
            </StatusBadge>
          ),
      },
      {
        accessorKey: "logicalBytes",
        header: t("tables.tenants.columns.logicalBytes"),
        enableGlobalFilter: false,
        meta: { numeric: true, className: "hidden xl:table-cell" },
        cell: ({ row }) => format.bytes(row.original.logicalBytes),
      },
      {
        accessorKey: "physicalBytes",
        header: t("tables.tenants.columns.physicalBytes"),
        enableGlobalFilter: false,
        meta: { numeric: true, className: "hidden xl:table-cell" },
        cell: ({ row }) => format.bytes(row.original.physicalBytes),
      },
      {
        id: "readiness",
        accessorFn: (row) => row.readiness ?? NOTHING_PROTECTED,
        header: t("tables.tenants.columns.readiness"),
        filterFn: matchesAnyOf,
        enableGlobalFilter: false,
        cell: ({ row }) => (
          <StatusBadge tone={readinessTone(row.original.readiness)}>
            {row.original.readiness === null
              ? t("tables.tenants.nothingProtected")
              : format.readiness(row.original.readiness)}
          </StatusBadge>
        ),
      },
      {
        accessorKey: "failures",
        header: t("tables.tenants.columns.failures"),
        enableGlobalFilter: false,
        meta: { numeric: true },
        cell: ({ row }) => format.integer(row.original.failures),
      },
      rowActionsColumn<TenantRow>({
        name: (row) => row.name,
        actions: (row) => [
          {
            id: "stats",
            label: t("tables.tenants.actions.stats"),
            icon: ChartColumn,
            onSelect: () => onOpenTenantStats(row.id),
          },
          {
            id: "tenant",
            label: t("tables.tenants.actions.tenant"),
            icon: Settings2,
            onSelect: () => void navigate({ to: tenantDetailTo(row.id) }),
          },
        ],
      }),
    ],
    [t, format, navigate, onOpenTenantStats],
  );

  return (
    <TableCard
      title={title}
      description={t("tables.tenants.description")}
      name="tenants"
      data={data}
    >
      <DataTable
        id="stats.tenants"
        label={title}
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        loading={data === undefined}
        sorting={{ mode: "client", initial: [{ id: "failures", desc: true }] }}
        pagination={{ mode: "client", pageSize: 10, pageSizes: [10, 25, 50] }}
        maxHeight="none"
        toolbar={(table) => (
          <>
            <DataTableSearch
              value={String(table.getState().globalFilter ?? "")}
              onChange={(value) => table.setGlobalFilter(value)}
              placeholder={t("tables.tenants.search")}
            />
            {readinessOptions.length > 1 ? (
              <DataTableFacetedFilter
                title={t("tables.tenants.columns.readiness")}
                options={readinessOptions}
                column={table.getColumn("readiness")}
              />
            ) : null}
          </>
        )}
        empty={
          <EmptyState
            variant="plain"
            icon={Building2}
            title={t("tables.tenants.empty.title")}
            description={t("tables.tenants.empty.description")}
          />
        }
      />
    </TableCard>
  );
}
