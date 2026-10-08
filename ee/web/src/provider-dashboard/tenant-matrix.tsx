import type { ColumnDef } from "@tanstack/react-table";
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
import { isStale, readinessRank, readinessTone, staleBound } from "@/features/dashboard/presenters";
import type { ReadinessState } from "@/features/verify/search";
import "@/features/dashboard/i18n";

/** The readiness facet of a row: its rating, `none` without objects, `unavailable` when unread. */
export function readinessFacet(row: ProviderTenantRow): string {
  if (!row.loaded) {
    return "unavailable";
  }
  return row.readiness ?? "none";
}

const READINESS_FACETS = ["red", "yellow", "green", "none", "unavailable"] as const;

/** How urgent a row is, worst first: red, yellow, green, no objects, figures that could not be read. */
function urgencyRank(row: ProviderTenantRow): number {
  return row.loaded ? readinessRank(row.readiness) : 4;
}

/**
 * The tenants by what needs doing: the operator's own organisation on top (it is
 * not a customer, and always the first thing its operator wants to see), then
 * the worst readiness first, more objects that cannot be restored first, more
 * unverified ones, more failed jobs, then by name. Tenants whose figures could
 * not be read sort last, with their name only.
 */
export function sortTenantRows(rows: readonly ProviderTenantRow[]): ProviderTenantRow[] {
  const figure = (row: ProviderTenantRow, pick: (loaded: LoadedTenantRow) => number) =>
    row.loaded ? pick(row) : 0;
  return [...rows].sort(
    (a, b) =>
      Number(b.kind === "internal") - Number(a.kind === "internal") ||
      urgencyRank(a) - urgencyRank(b) ||
      figure(b, (r) => r.notRestorable) - figure(a, (r) => r.notRestorable) ||
      figure(b, (r) => r.unverified) - figure(a, (r) => r.unverified) ||
      figure(b, (r) => r.failures24h) - figure(a, (r) => r.failures24h) ||
      a.name.localeCompare(b.name),
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

/** The tenant stays in view while the other columns scroll. */
const PINNED = ["name"] as const;

interface TenantMatrixProps {
  rows: ProviderTenantRow[];
  onOpenTenant: (tenantId: string) => void;
  onTenantDetails: (tenantId: string) => void;
  /** Switch into a tenant and on to its Recovery readiness in a state. */
  onOpenReadiness: (tenantId: string, state: ReadinessState) => void;
}

function useColumns({
  onOpenTenant,
  onTenantDetails,
  onOpenReadiness,
}: Omit<TenantMatrixProps, "rows">): ColumnDef<ProviderTenantRow>[] {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useMemo<ColumnDef<ProviderTenantRow>[]>(() => {
    const count = (value: number) => formatInteger(value, language);
    return [
      {
        id: "name",
        size: 260,
        accessorKey: "name",
        header: t("provider.matrix.columns.tenant"),
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-2">
            {/* The keyboard's way into the tenant; a click anywhere else on the row does the same. */}
            <button
              type="button"
              data-slot="open-tenant"
              onClick={() => onOpenTenant(row.original.id)}
              title={t("provider.matrix.openTenant", { name: row.original.name })}
              className="rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {row.original.name}
            </button>
            {row.original.kind === "internal" ? (
              <StatusBadge tone="info" data-flag="internal">
                {t("provider.matrix.internal")}
              </StatusBadge>
            ) : null}
            {row.original.status === "suspended" ? (
              <StatusBadge tone="muted">{t("provider.matrix.suspended")}</StatusBadge>
            ) : null}
          </span>
        ),
        meta: { label: t("provider.matrix.columns.tenant") },
      },
      {
        id: "readiness",
        size: 150,
        accessorFn: readinessFacet,
        header: t("provider.matrix.columns.readiness"),
        sortingFn: (a, b) => urgencyRank(a.original) - urgencyRank(b.original),
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
        id: "notRestorable",
        size: 140,
        accessorFn: (row) => known(row, (loaded) => loaded.notRestorable),
        sortUndefined: "last",
        header: t("provider.matrix.columns.notRestorable"),
        enableGlobalFilter: false,
        cell: ({ row }) => {
          const tenant = row.original;
          if (!tenant.loaded) {
            return <UnavailableFigure />;
          }
          // The count opens that tenant's Recovery readiness, filtered to what cannot be restored.
          return tenant.notRestorable > 0 ? (
            <button
              type="button"
              data-flag="not-restorable"
              onClick={() => onOpenReadiness(tenant.id, "red")}
              title={t("provider.matrix.openNotRestorable", { name: tenant.name })}
              className="rounded-sm font-medium text-destructive-text underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {count(tenant.notRestorable)}
            </button>
          ) : (
            <span className="text-muted-foreground">{count(0)}</span>
          );
        },
        meta: { numeric: true, label: t("provider.matrix.columns.notRestorable") },
      },
      {
        id: "unverified",
        size: 150,
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
        size: 120,
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
        size: 200,
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
              {isStale(tenant.lastBackupAt, Date.now(), tenant.staleAfterHours) ? (
                <StatusBadge tone="warning">
                  {staleBound(tenant.staleAfterHours).unit === "days"
                    ? t("lastBackup.staleDays", { count: staleBound(tenant.staleAfterHours).count })
                    : t("lastBackup.staleHours", { count: tenant.staleAfterHours })}
                </StatusBadge>
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
        size: 130,
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
        size: 130,
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
  }, [t, language, onOpenTenant, onTenantDetails, onOpenReadiness]);
}

/**
 * The tenants by what needs doing, in one table: readiness (unverified backups
 * flagged), the objects that cannot be restored (a link into that tenant's
 * Recovery readiness), failed jobs in the last 24 hours, the last successful
 * backup, mailboxes against the tenant's cap and a suspended badge. The own
 * organisation is on top with its "Internal" badge, then the worst first. A
 * click on a row switches into that tenant. A tenant whose figures could not be
 * read shows "not available" in every figure; only its mailbox count, which is
 * read separately, is shown.
 */
export function TenantMatrix({
  rows,
  onOpenTenant,
  onTenantDetails,
  onOpenReadiness,
}: TenantMatrixProps) {
  const { t } = useTranslation("dashboard");
  const columns = useColumns({ onOpenTenant, onTenantDetails, onOpenReadiness });
  const ordered = React.useMemo(() => sortTenantRows(rows), [rows]);
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
      data={ordered}
      getRowId={(row) => row.id}
      pinnedColumns={PINNED}
      // The order above is the default; a click on a header sorts from there.
      sorting={{ mode: "client", initial: [] }}
      pagination={{ mode: "client", pageSize: 10 }}
      onRowClick={(row) => onOpenTenant(row.id)}
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
