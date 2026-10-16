import { useQuery } from "@tanstack/react-query";
import { Building2, Clock, Loader2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, PageHeader, RelativeTime, StatusBadge } from "@/components/kit";
import {
  AllTenantsList,
  type AllTenantsListItem,
  type ListTenant,
} from "@/components/layout/all-tenants-list";
import { useSwitchTenant } from "@/components/tenant-switcher";
import { orderTenants } from "@/components/tenant-switcher-model";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import "@/features/backup-jobs/i18n";
import { describeJobSchedule, stateView } from "@/features/backup-jobs/presenters";
import "@/features/schedules/i18n";
import { hasFeature, useSession } from "@/lib/session";
import { canEnterTenant } from "@/lib/tenant";
import { cn } from "@/lib/utils";

import {
  fetchTenantJobSummaries,
  fetchTenantJobs,
  TENANT_JOB_KINDS,
  type TenantJobItem,
  type TenantJobKind,
  type TenantJobSummaries,
  tenantJobKeys,
} from "./api.js";
import {
  isTenantJobFilter,
  isTenantJobSort,
  matchesFilter,
  outcomeTone,
  refreshIntervalOf,
  sortRows,
  TENANT_JOB_FILTERS,
  TENANT_JOB_SORTS,
  type TenantJobFacts,
  type TenantJobFilter,
  type TenantJobSort,
  tenantJobFacts,
} from "./presenters.js";

/**
 * Jobs under "All tenants" (#63): instead of only asking for a tenant, the page lists every
 * tenant with its jobs counted (mail, machines, Proxmox VE), the backups that run or wait now,
 * how the newest ones ended and when the next run is planned. A row opens in place to list the
 * tenant's jobs read-only; "Switch to tenant" makes it the active one and the page continues as
 * that tenant's Jobs page. The figures come from one provider request for all tenants, renewed
 * every 15 seconds while something runs somewhere and every minute otherwise (the live channel is
 * per tenant; the server keeps each tenant's figures for half a minute); a tenant's jobs are asked
 * for only when its row is opened.
 *
 * `area` is the menu entry the page belongs to: its kinds come first in an opened row.
 */
export function TenantJobsOverview({ title, area }: { title: string; area: "mail" | "endpoint" }) {
  const { t } = useTranslation("backupjobs");
  const session = useSession();
  const switchTenant = useSwitchTenant();
  const organisationMode = !hasFeature(session, "tenants.additional");
  const [filter, setFilter] = React.useState<TenantJobFilter>("all");
  const [sort, setSort] = React.useState<TenantJobSort>("name");
  const kinds = kindOrder(area);
  const filterId = React.useId();
  const sortId = React.useId();

  const query = useQuery<TenantJobSummaries>({
    queryKey: tenantJobKeys.summaries(),
    queryFn: fetchTenantJobSummaries,
    enabled: session.status === "authenticated" && session.isProviderAdmin,
    refetchInterval: (current) => refreshIntervalOf(current.state.data?.tenants),
  });

  const byId = new Map((query.data?.tenants ?? []).map((row) => [row.tenantId, row]));
  const tenants = orderTenants(session.tenants);
  const rows = sortRows(
    tenants.map((tenant) => ({ tenant, facts: tenantJobFacts(byId.get(tenant.id)) })),
    sort,
  ).filter((row) => matchesFilter(row.facts, filter));

  const items: AllTenantsListItem[] = rows.map(({ tenant, facts }) => ({
    tenant,
    summary: query.data ? <TenantJobsSummary facts={facts} /> : <Skeleton className="h-5 w-40" />,
    detail: () => <TenantJobsDetail tenant={tenant} kinds={kinds} />,
    switchDisabled: !canEnterTenant(tenant.status, session.isProviderAdmin),
  }));

  return (
    <div className="space-y-6" data-slot="tenant-jobs-overview" data-area={area}>
      <PageHeader title={title} description={t("allTenants.description")} />
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor={filterId}>{t("allTenants.filter.label")}</Label>
          <Select
            value={filter}
            onValueChange={(value) => isTenantJobFilter(value) && setFilter(value)}
          >
            <SelectTrigger id={filterId} className="w-56" data-slot="tenant-jobs-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TENANT_JOB_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`allTenants.filter.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={sortId}>{t("allTenants.sort.label")}</Label>
          <Select value={sort} onValueChange={(value) => isTenantJobSort(value) && setSort(value)}>
            <SelectTrigger id={sortId} className="w-56" data-slot="tenant-jobs-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TENANT_JOB_SORTS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`allTenants.sort.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Said once the filter or the figures change, not on every refresh. */}
        <output aria-live="polite" className="pb-2 text-sm text-muted-foreground sm:ml-auto">
          {t("allTenants.shown", { shown: rows.length, total: tenants.length })}
        </output>
      </div>

      {query.isError ? (
        <ErrorState
          title={t("allTenants.loadError")}
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : null}

      {items.length > 0 ? (
        <AllTenantsList
          label={t("allTenants.list")}
          items={items}
          organisationMode={organisationMode}
          onSwitch={switchTenant}
        />
      ) : (
        <EmptyState
          icon={Building2}
          title={t(tenants.length === 0 ? "allTenants.empty.none" : "allTenants.empty.filtered")}
        />
      )}
    </div>
  );
}

/** The page's own kinds first: mail under Mail & SaaS, machines and Proxmox VE under Servers & clients. */
function kindOrder(area: "mail" | "endpoint"): TenantJobKind[] {
  return area === "mail" ? ["mail", "endpoint", "pve"] : ["endpoint", "pve", "mail"];
}

/**
 * Running work, as the sidebar shows it (#57): a spinner with the number of backups that run
 * (a still dot with reduced motion), Lapis because running proves nothing; waiting ones muted.
 */
function Activity({ running, queued }: { running: number; queued: number }) {
  const { t } = useTranslation();
  if (running === 0 && queued === 0) {
    return null;
  }
  return (
    <span
      className="inline-flex items-center gap-2 text-xs font-medium"
      data-slot="tenant-activity"
    >
      {running > 0 ? (
        <span className="inline-flex items-center gap-1 text-info-text">
          <Loader2
            aria-hidden="true"
            className="size-3 motion-safe:animate-spin motion-reduce:hidden"
          />
          <span
            aria-hidden="true"
            className="hidden size-1.5 rounded-full bg-info motion-reduce:inline-block"
          />
          {t("nav.activity.running", { count: running })}
        </span>
      ) : null}
      {queued > 0 ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Clock aria-hidden="true" className="size-3" />
          {t("nav.activity.queued", { count: queued })}
        </span>
      ) : null}
    </span>
  );
}

/** Beside a tenant's name: its jobs per kind, what runs, how the newest backups ended, the next run. */
function TenantJobsSummary({ facts }: { facts: TenantJobFacts | null }) {
  const { t } = useTranslation("backupjobs");
  if (facts === null) {
    return (
      <StatusBadge tone="warning" icon>
        {t("allTenants.unavailable")}
      </StatusBadge>
    );
  }
  if (facts.total === 0) {
    return (
      <span className="text-muted-foreground" data-slot="tenant-jobs-count">
        {t("allTenants.noJobs")}
      </span>
    );
  }
  const counts = TENANT_JOB_KINDS.filter((kind) => facts.jobs[kind] > 0).map((kind) =>
    t(`allTenants.kinds.${kind}`, { count: facts.jobs[kind] }),
  );
  return (
    <>
      <span className="text-muted-foreground" data-slot="tenant-jobs-count">
        {counts.join(" · ")}
        {facts.paused > 0 ? ` · ${t("allTenants.paused", { count: facts.paused })}` : null}
      </span>
      <Activity running={facts.running} queued={facts.queued} />
      <StatusBadge
        tone={outcomeTone(facts.outcome)}
        icon={facts.outcome !== "succeeded"}
        data-outcome={facts.outcome ?? "none"}
      >
        {t(`allTenants.outcome.${facts.outcome ?? "none"}`)}
      </StatusBadge>
      {facts.lastRunAt ? (
        <span className="whitespace-nowrap text-muted-foreground">
          {`${t("allTenants.lastRun")}: `}
          <RelativeTime value={facts.lastRunAt} focusable={false} />
        </span>
      ) : null}
      <span className="whitespace-nowrap text-muted-foreground" data-slot="tenant-jobs-next">
        {`${t("allTenants.nextRun")}: `}
        {facts.nextRunAt ? (
          <RelativeTime value={facts.nextRunAt} focusable={false} />
        ) : (
          t("allTenants.nothingPlanned")
        )}
      </span>
    </>
  );
}

/** An opened row: the tenant's jobs, read-only, loaded when it opens. */
function TenantJobsDetail({ tenant, kinds }: { tenant: ListTenant; kinds: TenantJobKind[] }) {
  const { t } = useTranslation("backupjobs");
  const query = useQuery({
    queryKey: tenantJobKeys.tenant(tenant.id),
    queryFn: () => fetchTenantJobs(tenant.id),
    refetchInterval: (current) =>
      current.state.data?.items.some((job) => job.lastRun.running > 0 || job.lastRun.queued > 0)
        ? 5_000
        : 30_000,
  });
  if (query.isPending) {
    return (
      <div aria-busy="true" className="space-y-2">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-2/3" />
        <span className="sr-only">{t("allTenants.jobs.loading", { name: tenant.name })}</span>
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title={t("allTenants.jobs.error")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const jobs = [...query.data.items].sort(
    (a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
  if (jobs.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("allTenants.jobs.empty")}</p>;
  }
  return (
    <div className="space-y-2">
      <ul
        aria-label={t("allTenants.jobs.label", { name: tenant.name })}
        className="divide-y rounded-md border bg-background"
        data-slot="tenant-jobs-detail"
      >
        {jobs.map((job) => (
          <TenantJobRow key={`${job.kind}:${job.id}`} job={job} />
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t("allTenants.jobs.readOnly")}</p>
    </div>
  );
}

/** Column layout from `md` on; on a phone each value gets its label and the cells stack. */
const JOB_GRID =
  "grid gap-x-4 gap-y-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center";

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 text-sm md:block">
      <span className="w-28 shrink-0 text-muted-foreground md:sr-only">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function TenantJobRow({ job }: { job: TenantJobItem }) {
  const { t, i18n } = useTranslation("backupjobs");
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const state = stateView(job.state);
  const columns = (key: string) => t(`allTenants.jobs.columns.${key}`);
  return (
    <li className={cn(JOB_GRID, "px-3 py-2")} data-job={job.id} data-kind={job.kind}>
      <div className="min-w-0">
        <span className="block truncate text-sm font-medium">{job.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {t(`allTenants.jobs.kind.${job.kind}`)}
        </span>
      </div>
      <Cell label={columns("scope")}>
        {job.scopeMode === "all"
          ? t("allTenants.jobs.scopeAll", { count: job.scopeCount })
          : t("allTenants.jobs.scopeSelected", { count: job.scopeCount })}
      </Cell>
      <Cell label={columns("schedule")}>
        {describeJobSchedule(job.schedule, { t, tSchedules, language })}
      </Cell>
      <Cell label={columns("lastRun")}>
        <RelativeTime
          value={job.lastRun.at}
          focusable={false}
          fallback={t("allTenants.jobs.never")}
        />
      </Cell>
      <Cell label={columns("nextRun")}>
        {job.nextRunAt ? (
          <RelativeTime value={job.nextRunAt} focusable={false} />
        ) : (
          <span className="text-muted-foreground">{t("allTenants.nothingPlanned")}</span>
        )}
      </Cell>
      <Cell label={columns("state")}>
        <StatusBadge tone={state.tone} live={state.live} className="whitespace-nowrap">
          {t(`state.${state.key}`)}
        </StatusBadge>
      </Cell>
    </li>
  );
}
