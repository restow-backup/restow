import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Building2,
  ChevronRight,
  Gauge,
  HardDrive,
  Hourglass,
  Info,
  TrendingUp,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, KpiTile, PageHeader, StatusBadge } from "@/components/kit";
import { RequireRole } from "@/components/require-role";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dayLabel } from "@/features/dashboard/presenters";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import {
  type Capacity,
  type CapacityKpis,
  type CapacityTenant,
  capacityKeys,
  fetchCapacity,
} from "./api.js";
import { RESOURCES_PATH } from "./paths.js";
import {
  ariaSortOf,
  CAPACITY_FILTERS,
  type CapacityFilter,
  type CapacitySort,
  type CapacitySortKey,
  DEFAULT_SORT,
  type FullView,
  fullView,
  growthHeadline,
  isCapacityFilter,
  isNearFull,
  matchesFilter,
  NEAR_FULL_DAYS,
  nextSort,
  sortTenants,
  spanOf,
} from "./presenters.js";
import { TenantDetail } from "./tenant-detail.js";
import "./i18n.js";

/**
 * Capacity planning: utilisation and growth per tenant and per repository, with a plain forecast
 * ("full in about 120 days"). Provider admins; the installation's figures on top, a table below
 * that sorts by the day a repository runs full, by growth, by what is stored or by name and that
 * can be narrowed to the tenants near their quota or heading for their limit. A row opens in
 * place to show how the figures come about and the tenant's repositories (loaded then).
 *
 * The forecast is an estimate and is never presented as a fact: it says "about" and "estimate",
 * and it never wears green (green is proof, components/kit/status-badge.tsx). A day appears only
 * where a limit is known; otherwise the cell says why not (not enough history, S3, the shared
 * default repository, a limit that could not be read).
 */

export { RESOURCES_PATH };

const COLUMNS: readonly { id: string; sort: CapacitySortKey | null }[] = [
  { id: "tenant", sort: "name" },
  { id: "stored", sort: "stored" },
  { id: "growth", sort: "growth" },
  { id: "free", sort: null },
  { id: "full", sort: "full" },
  { id: "quota", sort: null },
];

function useLanguage(): string {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? i18n.language;
}

export function ResourcesPage() {
  const { t } = useTranslation("resources");
  const { t: tCommon } = useTranslation();
  const language = useLanguage();
  const session = useSession();
  const [filter, setFilter] = React.useState<CapacityFilter>("all");
  const [sort, setSort] = React.useState<CapacitySort>(DEFAULT_SORT);
  const filterId = React.useId();

  const query = useQuery<Capacity>({
    queryKey: capacityKeys.overview(),
    queryFn: fetchCapacity,
    enabled: session.status === "authenticated" && session.isProviderAdmin,
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });
  const data = query.data;
  const rows = data
    ? sortTenants(
        data.tenants.filter((tenant) => matchesFilter(tenant, filter)),
        sort,
      )
    : [];

  return (
    <RequireRole roles={["provider_admin"]}>
      <div className="space-y-6" data-slot="resources-page">
        <PageHeader title={tCommon("nav.items.resources")} description={t("description")} />

        {data?.scope === "tenant" ? (
          <Alert variant="info" data-slot="resources-scope">
            <Info />
            <AlertDescription>{t("scopeTenant")}</AlertDescription>
          </Alert>
        ) : null}

        {/* Without figures there is no tile: zeros and "no date" would read as measurements. */}
        {data || query.isPending ? (
          <Kpis
            kpis={data?.kpis ?? null}
            tenants={data?.tenants.length ?? 0}
            loading={query.isPending}
          />
        ) : null}

        {query.isError ? (
          <ErrorState
            title={t("loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : null}

        {data ? (
          <>
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
              <div className="grid gap-1.5">
                <Label htmlFor={filterId}>{t("filter.label")}</Label>
                <Select
                  value={filter}
                  onValueChange={(value) => isCapacityFilter(value) && setFilter(value)}
                >
                  <SelectTrigger id={filterId} className="w-56" data-slot="resources-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CAPACITY_FILTERS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`filter.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Said once the filter or the figures change, not on every refresh. */}
              <output aria-live="polite" className="pb-2 text-sm text-muted-foreground">
                {t("filter.shown", { shown: rows.length, total: data.tenants.length })}
              </output>
              <p className="pb-2 text-sm text-muted-foreground sm:ml-auto">
                {t("updated", { time: formatDateTime(data.generatedAt, language) ?? "" })}
              </p>
            </div>

            {rows.length > 0 ? (
              <CapacityTable
                rows={rows}
                sort={sort}
                onSort={(key) => setSort(nextSort(sort, key))}
              />
            ) : (
              <EmptyState
                icon={Gauge}
                title={t(data.tenants.length === 0 ? "empty.none" : "empty.filtered")}
                description={t(
                  data.tenants.length === 0 ? "empty.noneDescription" : "empty.filteredDescription",
                )}
              />
            )}
            <p className="max-w-prose text-xs text-muted-foreground">{t("estimateNote")}</p>
          </>
        ) : null}
      </div>
    </RequireRole>
  );
}

// ---------------------------------------------------------------------------
// Key figures
// ---------------------------------------------------------------------------

function spanText(days: number, t: (key: string, values?: Record<string, unknown>) => string) {
  const span = spanOf(days);
  return t(`span.${span.unit}`, { count: span.count });
}

function Kpis({
  kpis,
  tenants,
  loading,
}: {
  kpis: CapacityKpis | null;
  tenants: number;
  loading: boolean;
}) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  const growth = kpis?.growthBytesPerDay ?? null;
  const disk = kpis?.systemDisk ?? null;
  const earliest = kpis?.earliestFull ?? null;
  const trend = disk?.trend ?? null;

  const diskHint = disk
    ? [
        disk.totalBytes !== null
          ? t("kpi.systemDisk.hint", { total: formatBytes(disk.totalBytes, language) })
          : null,
        trend && trend.bytesPerDay < 0
          ? t("kpi.systemDisk.shrinking", { bytes: formatBytes(-trend.bytesPerDay, language) })
          : null,
        trend?.fullOn
          ? t("kpi.systemDisk.fullAround", {
              date: dayLabel(trend.fullOn.slice(0, 10), language, "long"),
            })
          : null,
        trend === null ? t("kpi.systemDisk.trendPending") : null,
      ]
        .filter(Boolean)
        .join(" ")
    : t("kpi.systemDisk.notWatchedHint");

  return (
    <section
      aria-label={t("kpi.label")}
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
      data-slot="resources-kpis"
    >
      <KpiTile
        label={t("kpi.stored.label")}
        icon={HardDrive}
        loading={loading}
        value={formatBytes(kpis?.totalBytes ?? 0, language)}
        hint={t("kpi.stored.hint", { count: tenants })}
      />
      <KpiTile
        label={t("kpi.growth.label")}
        icon={TrendingUp}
        loading={loading}
        value={
          growth === null
            ? t("kpi.growth.none")
            : t(growth < 0 ? "kpi.growth.valueLess" : "kpi.growth.value", {
                bytes: formatBytes(Math.abs(growth), language),
              })
        }
        hint={
          growth === null
            ? undefined
            : t("kpi.growth.hint", { count: kpis?.growthTenants ?? 0, total: tenants })
        }
      />
      <KpiTile
        label={t("kpi.systemDisk.label")}
        icon={HardDrive}
        loading={loading}
        value={
          disk?.freeBytes != null
            ? t("kpi.systemDisk.value", { free: formatBytes(disk.freeBytes, language) })
            : t("kpi.systemDisk.notWatched")
        }
        hint={diskHint}
      />
      <KpiTile
        label={t("kpi.earliest.label")}
        icon={Hourglass}
        loading={loading}
        value={
          earliest
            ? t("kpi.earliest.value", { span: spanText(earliest.inDays, t) })
            : t("kpi.earliest.none")
        }
        hint={
          earliest
            ? earliest.name
              ? t("kpi.earliest.hint", {
                  name: earliest.name,
                  date: dayLabel(earliest.date, language, "long"),
                })
              : t("kpi.earliest.hintDisk", { date: dayLabel(earliest.date, language, "long") })
            : t("kpi.earliest.noneHint")
        }
      />
      <KpiTile
        label={t("kpi.quota.label")}
        icon={Gauge}
        loading={loading}
        value={t("kpi.quota.value", { count: kpis?.tenantsNearQuota ?? 0 })}
        hint={
          (kpis?.tenantsNearFull ?? 0) > 0
            ? t("kpi.quota.hint", { count: kpis?.tenantsNearFull ?? 0, days: NEAR_FULL_DAYS })
            : t("kpi.quota.hintNone", { days: NEAR_FULL_DAYS })
        }
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

function SortHeader({
  column,
  sort,
  onSort,
}: {
  column: (typeof COLUMNS)[number];
  sort: CapacitySort;
  onSort: (key: CapacitySortKey) => void;
}) {
  const { t } = useTranslation("resources");
  const label = t(`table.columns.${column.id}`);
  const key = column.sort;
  if (key === null) {
    return <TableHead scope="col">{label}</TableHead>;
  }
  const Icon = sort.key !== key ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead scope="col" aria-sort={ariaSortOf(sort, key)}>
      <button
        type="button"
        onClick={() => onSort(key)}
        data-slot="resources-sort"
        data-sort={key}
        className="-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-left font-medium outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {label}
        <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="sr-only">{t("table.sortBy", { column: label })}</span>
      </button>
    </TableHead>
  );
}

function CapacityTable({
  rows,
  sort,
  onSort,
}: {
  rows: readonly CapacityTenant[];
  sort: CapacitySort;
  onSort: (key: CapacitySortKey) => void;
}) {
  const { t } = useTranslation("resources");
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggle = React.useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <div className="rounded-lg border bg-card" data-slot="resources-table">
      <Table aria-label={t("table.label")}>
        <TableHeader>
          <TableRow>
            {COLUMNS.map((column) => (
              <SortHeader key={column.id} column={column} sort={sort} onSort={onSort} />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((tenant) => (
            <TenantRows
              key={tenant.tenantId}
              tenant={tenant}
              expanded={open.has(tenant.tenantId)}
              onToggle={toggle}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TenantRows({
  tenant,
  expanded,
  onToggle,
}: {
  tenant: CapacityTenant;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation("resources");
  const { t: tCommon } = useTranslation();
  const language = useLanguage();
  const id = React.useId();
  const panelId = `${id}-panel`;
  const stored = tenant.usedBytes;

  return (
    <>
      <TableRow data-tenant={tenant.tenantId} data-expanded={expanded || undefined}>
        <TableCell>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            aria-label={t("table.open", { name: tenant.name })}
            onClick={() => onToggle(tenant.tenantId)}
            data-slot="resources-toggle"
            className="-mx-2 -my-1 flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
                expanded && "rotate-90",
              )}
            />
            <Building2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{tenant.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {t(tenant.kind === "internal" ? "table.internal" : "table.customer")}
              </span>
            </span>
          </button>
          {tenant.status === "active" ? null : (
            <StatusBadge tone="warning" className="ml-6 mt-1">
              {tCommon(`tenant.status.${tenant.status}`)}
            </StatusBadge>
          )}
        </TableCell>
        <TableCell className="tabular-nums" data-slot="resources-stored">
          {stored === null ? (
            <span className="text-muted-foreground">{t("table.unavailable")}</span>
          ) : (
            <>
              <span className="block text-sm">{formatBytes(stored, language)}</span>
              <span className="block text-xs text-muted-foreground">
                {tenant.repositoryBytes
                  ? `${formatBytes(tenant.chunkStoreBytes ?? 0, language)} + ${formatBytes(tenant.repositoryBytes, language)}`
                  : null}
              </span>
            </>
          )}
        </TableCell>
        <TableCell className="tabular-nums" data-slot="resources-growth">
          <GrowthCell tenant={tenant} />
        </TableCell>
        <TableCell className="tabular-nums" data-slot="resources-free">
          <FreeCell tenant={tenant} />
        </TableCell>
        <TableCell data-slot="resources-full">
          <FullCell view={fullView(tenant)} />
        </TableCell>
        <TableCell data-slot="resources-quota">
          <QuotaCell tenant={tenant} />
        </TableCell>
      </TableRow>
      {/* Always present, so `aria-controls` names an element; its content exists only while open. */}
      <TableRow
        id={panelId}
        hidden={!expanded}
        data-slot="resources-detail"
        className="bg-muted/30 hover:bg-muted/30"
      >
        <TableCell colSpan={COLUMNS.length}>
          {expanded ? <TenantDetail tenant={tenant} /> : null}
        </TableCell>
      </TableRow>
    </>
  );
}

function GrowthCell({ tenant }: { tenant: CapacityTenant }) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  const headline = tenant.state === "ok" ? growthHeadline(tenant.growth) : null;
  if (!headline) {
    return (
      <span className="text-muted-foreground" data-growth="none">
        {tenant.state === "ok" ? t("growth.none") : t("table.unavailable")}
      </span>
    );
  }
  const { bytesPerDay, days } = headline;
  return (
    <>
      <span className="block text-sm" data-growth={days}>
        {bytesPerDay === 0
          ? t("growth.flat")
          : t(bytesPerDay < 0 ? "growth.headlineLess" : "growth.headline", {
              bytes: formatBytes(Math.abs(bytesPerDay), language),
            })}
      </span>
      <span className="block text-xs text-muted-foreground">{t("growth.over", { days })}</span>
    </>
  );
}

function FreeCell({ tenant }: { tenant: CapacityTenant }) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  const { freeBytes, totalBytes } = tenant.limit;
  if (tenant.state !== "ok" || freeBytes === null || totalBytes === null) {
    return <span className="text-muted-foreground">{t("free.none")}</span>;
  }
  return (
    <span className="text-sm">
      {t("free.of", {
        free: formatBytes(freeBytes, language),
        total: formatBytes(totalBytes, language),
      })}
    </span>
  );
}

const EMPTY_FULL_KEY: Readonly<Record<Exclude<FullView["kind"], "date">, string>> = {
  unavailable: "full.unavailable",
  s3: "full.s3",
  shared_default: "full.sharedDefault",
  unknown_limit: "full.unknownLimit",
  no_history: "full.noHistory",
  other_data: "full.otherData",
  no_date: "full.noDate",
};

/**
 * The day a repository runs full, always worded as an estimate and never in green: a warning from
 * {@link NEAR_FULL_DAYS} days on, plain text before. Where there is no day, why not.
 */
function FullCell({ view }: { view: FullView }) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  if (view.kind !== "date") {
    return (
      <span className="text-sm text-muted-foreground" data-full-state={view.kind}>
        {t(EMPTY_FULL_KEY[view.kind])}
      </span>
    );
  }
  const span = spanOf(view.inDays);
  const headline = t("full.inDays", { span: t(`span.${span.unit}`, { count: span.count }) });
  const detail = view.between
    ? t("full.between", {
        earliest: dayLabel(view.between.earliest, language, "long"),
        latest: dayLabel(view.between.latest, language, "long"),
      })
    : view.from
      ? t("full.from", { date: dayLabel(view.from, language, "long") })
      : t("full.around", { date: dayLabel(view.date, language, "long") });
  return (
    <div data-full-state="date" data-in-days={view.inDays}>
      {isNearFull(view.inDays) ? (
        <StatusBadge tone="warning" icon>
          {headline}
        </StatusBadge>
      ) : (
        <span className="block text-sm">{headline}</span>
      )}
      <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function QuotaCell({ tenant }: { tenant: CapacityTenant }) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  if (tenant.state !== "ok" || tenant.quotas.length === 0) {
    return <span className="text-sm text-muted-foreground">{t("quota.none")}</span>;
  }
  return (
    <ul className="space-y-1">
      {tenant.quotas.map((quota) => (
        <li key={quota.scope} data-quota={quota.scope} data-level={quota.level}>
          <span className="block text-xs text-muted-foreground">
            {t(`quota.scope.${quota.scope}`)}
          </span>
          {quota.level === "ok" ? (
            <span className="text-sm">{t("quota.ok")}</span>
          ) : (
            <StatusBadge tone={quota.level === "exceeded" ? "destructive" : "warning"} icon>
              {t(`quota.${quota.level}`)}
            </StatusBadge>
          )}
          {quota.percent !== null && quota.budgetBytes !== null ? (
            <span className="block text-xs text-muted-foreground tabular-nums">
              {t("quota.percent", {
                percent: quota.percent,
                budget: formatBytes(quota.budgetBytes, language),
              })}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
