import type { ColumnDef, Row } from "@tanstack/react-table";
import { Building2, ExternalLink, LayoutDashboard, SearchX } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  DataTable,
  DataTableFacetedFilter,
  DataTableSearch,
  EmptyState,
  RelativeTime,
  StatusBadge,
  matchesAnyOf,
  rowActionsColumn,
} from "@/components/kit";
import { formatBytes, formatInteger } from "@/lib/format";

import type { LoadedTenantRow, ProviderTenantRow } from "@/features/dashboard/api";
import { isStale, readinessRank, readinessTone } from "@/features/dashboard/presenters";
import "@/features/dashboard/i18n";

/** The readiness facet of a row: its rating, `none` without objects, `unavailable` when unread. */
export function readinessFacet(row: ProviderTenantRow): string {
  if (!row.loaded) {
    return "unavailable";
  }
  return row.readiness ?? "none";
}

const READINESS_FACETS = ["red", "yellow", "green", "none", "unavailable"] as const;

function byReadiness(a: Row<ProviderTenantRow>, b: Row<ProviderTenantRow>): number {
  const rank = (row: ProviderTenantRow) => (row.loaded ? readinessRank(row.readiness) : 4);
  return (
    rank(a.original) - rank(b.original) ||
    (b.original.unverified ?? 0) - (a.original.unverified ?? 0)
  );
}

/**
 * A figure of a tenant whose figures could not be read: a dash that screen
 * readers announce as "Not available". Never a zero, which would read as
 * "nothing wrong".
 */
export function UnavailableFigure() {
  const { t } = useTranslation("dashboard");
  return (
    <span className="text-muted-foreground" data-figure="unavailable">
      <span aria-hidden="true">–</span>
      <span className="sr-only">{t("provider.matrix.unavailable")}</span>
    </span>
  );
}

/** A figure for sorting: unknown figures (unread tenants) sort after every known one. */
function known<T>(row: ProviderTenantRow, pick: (loaded: LoadedTenantRow) => T): T | undefined {
  return row.loaded ? pick(row) : undefined;
}

interface TenantMatrixProps {
  rows: ProviderTenantRow[];
  onOpenTenant: (tenantId: string) => void;
  onTenantDetails: (tenantId: string) => void;
}

function useColumns({
  onOpenTenant,
  onTenantDetails,
}: Omit<TenantMatrixProps, "rows">): ColumnDef<ProviderTenantRow>[] {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useMemo<ColumnDef<ProviderTenantRow>[]>(() => {
    const count = (value: number) => formatInteger(value, language);
    return [
      {
        id: "name",
        accessorKey: "name",
        header: t("provider.matrix.columns.tenant"),
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{row.original.name}</span>
            {row.original.status === "suspended" ? (
              <StatusBadge tone="muted">{t("provider.matrix.suspended")}</StatusBadge>
            ) : null}
          </span>
        ),
        meta: { label: t("provider.matrix.columns.tenant") },
      },
      {
        id: "readiness",
        accessorFn: readinessFacet,
        header: t("provider.matrix.columns.readiness"),
        sortingFn: byReadiness,
        filterFn: matchesAnyOf,
        enableGlobalFilter: false,
        cell: ({ row }) =>
          row.original.loaded ? (
            <StatusBadge tone={readinessTone(row.original.readiness)} icon>
              {t(`readiness.overall.${row.original.readiness ?? "none"}`)}
            </StatusBadge>
          ) : (
            <StatusBadge tone="muted">{t("provider.matrix.unavailable")}</StatusBadge>
          ),
        meta: { label: t("provider.matrix.columns.readiness") },
      },
      {
        id: "unverified",
        accessorFn: (row) => known(row, (loaded) => loaded.unverified),
        sortUndefined: "last",
        header: t("provider.matrix.columns.unverified"),
        enableGlobalFilter: false,
        cell: ({ row }) => {
          const tenant = row.original;
          if (!tenant.loaded) {
            return <UnavailableFigure />;
          }
          return tenant.unverified > 0 ? (
            <StatusBadge tone="warning" data-flag="unverified">
              {t("provider.matrix.unverifiedCount", { count: tenant.unverified })}
            </StatusBadge>
          ) : (
            <span className="text-muted-foreground">{count(0)}</span>
          );
        },
        meta: { numeric: true, label: t("provider.matrix.columns.unverified") },
      },
      {
        id: "failures24h",
        accessorFn: (row) => known(row, (loaded) => loaded.failures24h),
        sortUndefined: "last",
        header: t("provider.matrix.columns.failures"),
        enableGlobalFilter: false,
        cell: ({ row }) => {
          const tenant = row.original;
          if (!tenant.loaded) {
            return <UnavailableFigure />;
          }
          return (
            <span
              className={
                tenant.failures24h > 0
                  ? "font-medium text-destructive-text"
                  : "text-muted-foreground"
              }
            >
              {count(tenant.failures24h)}
            </span>
          );
        },
        meta: { numeric: true, label: t("provider.matrix.columns.failures") },
      },
      {
        id: "lastBackupAt",
        // No backup yet sorts as the oldest; an unread tenant after everything.
        accessorFn: (row) => known(row, (loaded) => loaded.lastBackupAt ?? ""),
        sortUndefined: "last",
        header: t("provider.matrix.columns.lastBackup"),
        enableGlobalFilter: false,
        cell: ({ row }) => {
          const tenant = row.original;
          if (!tenant.loaded) {
            return <UnavailableFigure />;
          }
          return (
            <span className="flex items-center gap-2">
              {isStale(tenant.lastBackupAt, Date.now()) ? (
                <StatusBadge tone="warning">{t("lastBackup.stale")}</StatusBadge>
              ) : null}
              <RelativeTime
                value={tenant.lastBackupAt}
                fallback={t("lastBackup.never")}
                focusable={false}
              />
            </span>
          );
        },
        meta: { label: t("provider.matrix.columns.lastBackup") },
      },
      {
        id: "mailboxes",
        accessorKey: "mailboxes",
        header: t("provider.matrix.columns.mailboxes"),
        enableGlobalFilter: false,
        cell: ({ row }) => {
          const { mailboxes, mailboxCap } = row.original;
          const over = mailboxCap !== null && mailboxes > mailboxCap;
          return (
            <span className={over ? "font-medium text-warning-text" : undefined}>
              {mailboxCap === null
                ? count(mailboxes)
                : t("provider.matrix.ofCap", { used: count(mailboxes), cap: count(mailboxCap) })}
            </span>
          );
        },
        meta: { numeric: true, label: t("provider.matrix.columns.mailboxes") },
      },
      {
        id: "physicalBytes",
        accessorFn: (row) => known(row, (loaded) => loaded.physicalBytes),
        sortUndefined: "last",
        header: t("provider.matrix.columns.stored"),
        enableGlobalFilter: false,
        cell: ({ row }) =>
          row.original.loaded ? (
            formatBytes(row.original.physicalBytes, language)
          ) : (
            <UnavailableFigure />
          ),
        meta: {
          numeric: true,
          label: t("provider.matrix.columns.stored"),
          className: "hidden lg:table-cell",
        },
      },
      rowActionsColumn<ProviderTenantRow>({
        name: (row) => row.name,
        actions: (row) => [
          {
            id: "open",
            label: t("provider.matrix.actions.open"),
            icon: LayoutDashboard,
            onSelect: () => onOpenTenant(row.id),
            disabled: row.status !== "active" && row.status !== "suspended",
          },
          {
            id: "details",
            label: t("provider.matrix.actions.details"),
            icon: ExternalLink,
            onSelect: () => onTenantDetails(row.id),
          },
        ],
      }),
    ];
  }, [t, language, onOpenTenant, onTenantDetails]);
}

/**
 * Every tenant's health in one table: readiness (unverified backups flagged),
 * failed jobs in the last 24 hours, the last successful backup, mailboxes
 * against the tenant's cap and a suspended badge. Worst first by default. A
 * tenant whose figures could not be read shows "not available" in every
 * figure; only its mailbox count, which is read separately, is shown.
 */
export function TenantMatrix({ rows, onOpenTenant, onTenantDetails }: TenantMatrixProps) {
  const { t } = useTranslation("dashboard");
  const columns = useColumns({ onOpenTenant, onTenantDetails });
  const readinessOptions = READINESS_FACETS.map((value) => ({
    value,
    label:
      value === "unavailable" ? t("provider.matrix.unavailable") : t(`readiness.overall.${value}`),
  }));

  return (
    <DataTable
      id="dashboard.provider.tenants"
      label={t("provider.matrix.title")}
      columns={columns}
      data={rows}
      getRowId={(row) => row.id}
      sorting={{ mode: "client", initial: [{ id: "readiness", desc: false }] }}
      pagination={{ mode: "client", pageSize: 10 }}
      toolbar={(table) => (
        <>
          <DataTableSearch
            value={String(table.getState().globalFilter ?? "")}
            onChange={(value) => table.setGlobalFilter(value)}
            placeholder={t("provider.matrix.search")}
          />
          <DataTableFacetedFilter
            title={t("provider.matrix.columns.readiness")}
            options={readinessOptions}
            column={table.getColumn("readiness")}
          />
        </>
      )}
      empty={
        <EmptyState
          icon={Building2}
          title={t("provider.empty.title")}
          description={t("provider.empty.description")}
          variant="plain"
        />
      }
      filteredEmpty={
        <EmptyState
          icon={SearchX}
          title={t("provider.matrix.filteredEmpty.title")}
          description={t("provider.matrix.filteredEmpty.description")}
          variant="plain"
        />
      }
    />
  );
}
