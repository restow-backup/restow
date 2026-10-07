import type { ColumnDef } from "@tanstack/react-table";
import { Building2, ChevronRight, ShieldQuestion } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DataTable, EmptyState, ErrorState, StatusBadge } from "@/components/kit";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { LoadedTenantRow, ProviderTenantRow } from "@/features/dashboard/api";
import { WidgetUnavailableError } from "@/features/dashboard/presenters";
import { StateChips, countsOfSummary } from "@/features/verify/components/state-chips";
import { READINESS_STATES, type ReadinessState } from "@/features/verify/search";
import { formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { SlotProps } from "@/lib/extensions";
import "@/features/dashboard/i18n";
import "@/features/verify/i18n";

/** The count of a tenant's objects in a state, as the provider view reports it. */
export function countInState(row: LoadedTenantRow, state: ReadinessState): number {
  switch (state) {
    case "green":
      return row.ready;
    case "yellow":
      return row.needsAttention;
    case "red":
      return row.notRestorable;
    case "unverified":
      return row.unverified;
    case "no_backup":
      return row.noBackup;
  }
}

/** The objects a tenant has that are rated at all. */
export function ratedObjects(row: LoadedTenantRow): number {
  return READINESS_STATES.reduce((sum, state) => sum + countInState(row, state), 0);
}

/**
 * The tenants to list for a state: the ones that have objects in it, the most
 * first (the own organisation on top as everywhere else); without a state, every
 * tenant that has objects. A tenant whose figures could not be read is not in the
 * list, the page says how many are missing.
 */
export function tenantsInState(
  rows: readonly ProviderTenantRow[],
  state: ReadinessState | undefined,
): LoadedTenantRow[] {
  const loaded = rows.filter((row): row is LoadedTenantRow => row.loaded);
  return loaded
    .filter((row) => (state ? countInState(row, state) > 0 : ratedObjects(row) > 0))
    .sort(
      (a, b) =>
        Number(b.kind === "internal") - Number(a.kind === "internal") ||
        (state ? countInState(b, state) - countInState(a, state) : 0) ||
        a.name.localeCompare(b.name),
    );
}

const PINNED = ["name"] as const;

function useColumns(
  state: ReadinessState | undefined,
  onOpen: (tenantId: string, state: ReadinessState | undefined) => void,
): ColumnDef<LoadedTenantRow>[] {
  const { t, i18n } = useTranslation("verify");
  const { t: td } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useMemo<ColumnDef<LoadedTenantRow>[]>(() => {
    const columns: ColumnDef<LoadedTenantRow>[] = [
      {
        id: "name",
        size: 220,
        accessorKey: "name",
        header: t("byTenant.columns.tenant"),
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-2">
            {/* The keyboard's way in; a click anywhere else on the row does the same. */}
            <button
              type="button"
              data-slot="open-tenant"
              onClick={() => onOpen(row.original.id, state)}
              title={t("byTenant.open", { name: row.original.name })}
              className="rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {row.original.name}
            </button>
            {row.original.kind === "internal" ? (
              <StatusBadge tone="info" data-flag="internal">
                {td("provider.matrix.internal")}
              </StatusBadge>
            ) : null}
          </span>
        ),
        meta: { label: t("byTenant.columns.tenant") },
      },
    ];
    for (const column of READINESS_STATES) {
      columns.push({
        id: column,
        size: 118,
        accessorFn: (row) => countInState(row, column),
        header: t(`state.${column}`),
        enableGlobalFilter: false,
        cell: ({ row }) => {
          const count = countInState(row.original, column);
          return count > 0 ? (
            <button
              type="button"
              data-count={column}
              onClick={() => onOpen(row.original.id, column)}
              title={t("byTenant.openState", {
                name: row.original.name,
                state: t(`state.${column}`),
              })}
              className={cn(
                "rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50",
                column === state && "font-semibold",
              )}
            >
              {formatInteger(count, language)}
            </button>
          ) : (
            <span className="text-muted-foreground">{formatInteger(0, language)}</span>
          );
        },
        meta: { numeric: true, label: t(`state.${column}`) },
      });
    }
    columns.push({
      id: "total",
      size: 90,
      accessorFn: ratedObjects,
      header: t("byTenant.columns.total"),
      enableGlobalFilter: false,
      cell: ({ row }) => formatInteger(ratedObjects(row.original), language),
      meta: { numeric: true, label: t("byTenant.columns.total") },
    });
    columns.push({
      id: "go",
      size: 36,
      header: () => <span className="sr-only">{t("byTenant.columns.go")}</span>,
      enableSorting: false,
      cell: () => <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />,
      meta: { label: t("byTenant.columns.go") },
    });
    return columns;
  }, [t, td, language, state, onOpen]);
}

/**
 * Recovery readiness under "All tenants": the tenants that have objects in a
 * state, with their counts by state, built from the provider view of the overview.
 * There is no list of objects across tenants; choosing a tenant (its name, a row, or
 * a count) switches into it and opens its own Recovery readiness, in that state.
 * The chips are the same as on a tenant's page and set the address.
 */
export function ReadinessByTenant({
  view,
  onRetry,
  retrying,
  state,
  onStateChange,
  onOpenReadiness,
}: SlotProps["verify.byTenant"]) {
  const { t } = useTranslation("verify");
  const columns = useColumns(state, onOpenReadiness);

  if (view.kind === "error") {
    return (
      <div data-widget="verify-by-tenant" data-state="error">
        <ErrorState
          title={t("byTenant.error")}
          error={view.error ?? new WidgetUnavailableError()}
          onRetry={onRetry}
          retrying={retrying}
        />
      </div>
    );
  }
  if (view.kind === "loading") {
    return (
      <div
        data-widget="verify-by-tenant"
        data-state="loading"
        className="space-y-4"
        aria-busy="true"
      >
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-64 w-full" />
        <span className="sr-only">{t("byTenant.loading")}</span>
      </div>
    );
  }

  const { kpis, tenants } = view.data;
  const rows = tenantsInState(tenants, state);
  return (
    <div data-widget="verify-by-tenant" data-state="ready" className="flex min-w-0 flex-col gap-4">
      <StateChips
        counts={countsOfSummary(kpis.readiness)}
        total={kpis.readiness.total}
        value={state}
        onChange={onStateChange}
      />
      <Card className="min-w-0 gap-0 overflow-hidden py-0">
        <DataTable
          id="verify.byTenant"
          label={t("byTenant.title")}
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          pinnedColumns={PINNED}
          sorting={{ mode: "client", initial: [] }}
          pagination={{ mode: "client", pageSize: 25 }}
          onRowClick={(row) => onOpenReadiness(row.id, state)}
          columnsMenu={false}
          empty={
            <EmptyState
              icon={state ? ShieldQuestion : Building2}
              title={t(state ? "byTenant.empty.state" : "byTenant.empty.any", {
                state: state ? t(`state.${state}`) : "",
              })}
              description={t("byTenant.empty.description")}
              variant="plain"
            />
          }
        />
      </Card>
      <p className="text-xs text-muted-foreground">
        {t("byTenant.hint")}
        {kpis.unavailableTenants > 0 ? (
          <>
            {" "}
            <span className="font-medium text-warning-text" data-flag="incomplete">
              {t("byTenant.incomplete", { count: kpis.unavailableTenants })}
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
