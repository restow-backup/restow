import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState, StatusBadge } from "@/components/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/format";

import {
  type CapacityGrowth,
  type CapacityRepository,
  type CapacityTarget,
  type CapacityTenant,
  type CapacityTenantDetail,
  capacityKeys,
  fetchCapacityTenant,
} from "./api.js";
import "./i18n.js";

function useLanguage(): string {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? i18n.language;
}

/**
 * An opened row: how the tenant's figures come about (what the growth is read from, the
 * estimate, the limit) from the overview the row belongs to, and the tenant's repositories,
 * loaded when the row opens.
 */
export function TenantDetail({ tenant }: { tenant: CapacityTenant }) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  const query = useQuery<CapacityTenantDetail>({
    queryKey: capacityKeys.tenant(tenant.tenantId),
    queryFn: () => fetchCapacityTenant(tenant.tenantId),
    enabled: tenant.state === "ok",
    staleTime: 30_000,
  });

  if (tenant.state !== "ok") {
    return <p className="text-sm text-muted-foreground">{t("table.unavailable")}</p>;
  }

  return (
    <div className="grid gap-6 py-1 lg:grid-cols-2" data-slot="resources-detail-body">
      <div className="space-y-4 text-sm">
        <section aria-labelledby={`${tenant.tenantId}-growth`} className="space-y-1">
          <h3 id={`${tenant.tenantId}-growth`} className="font-medium">
            {t("detail.growth")}
          </h3>
          <GrowthList growth={tenant.growth} />
          <p className="text-xs text-muted-foreground">
            {t(`growth.basis.${tenant.basis}`, { days: tenant.historyDays })}
          </p>
        </section>

        <section aria-labelledby={`${tenant.tenantId}-forecast`} className="space-y-1">
          <h3 id={`${tenant.tenantId}-forecast`} className="font-medium">
            {t("detail.forecast")}
          </h3>
          <p data-slot="resources-forecast">
            {tenant.forecast === null
              ? t("detail.noForecast")
              : tenant.forecast.band
                ? t("detail.forecastBand", {
                    days: tenant.forecast.basisDays,
                    bytes: formatBytes(tenant.forecast.slopeBytesPerDay, language),
                    slowest: formatBytes(
                      Math.max(0, tenant.forecast.band.slowestBytesPerDay),
                      language,
                    ),
                    fastest: formatBytes(tenant.forecast.band.fastestBytesPerDay, language),
                  })
                : t("detail.forecastLine", {
                    days: tenant.forecast.basisDays,
                    bytes: formatBytes(tenant.forecast.slopeBytesPerDay, language),
                  })}
          </p>
        </section>

        <section aria-labelledby={`${tenant.tenantId}-limit`} className="space-y-1">
          <h3 id={`${tenant.tenantId}-limit`} className="font-medium">
            {t("detail.limit")}
          </h3>
          <LimitText tenant={tenant} />
        </section>
      </div>

      <section aria-labelledby={`${tenant.tenantId}-repositories`} className="space-y-3 text-sm">
        <h3 id={`${tenant.tenantId}-repositories`} className="font-medium">
          {t("detail.repositories")}
        </h3>
        {query.isPending ? (
          <div aria-busy="true" className="space-y-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
            <span className="sr-only">{t("detail.loading", { name: tenant.name })}</span>
          </div>
        ) : query.isError ? (
          <ErrorState
            title={t("detail.error")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : (
          <Repositories detail={query.data} />
        )}
      </section>
    </div>
  );
}

function GrowthList({ growth }: { growth: CapacityGrowth }) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  const horizons = [
    [7, growth.days7],
    [30, growth.days30],
    [90, growth.days90],
  ] as const;
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 tabular-nums"
      data-slot="resources-horizons"
    >
      {horizons.map(([days, bytesPerDay]) => (
        <React.Fragment key={days}>
          <dt className="text-muted-foreground">{t("growth.horizon", { days })}</dt>
          <dd data-horizon={days}>
            {bytesPerDay === null
              ? t("growth.none")
              : bytesPerDay === 0
                ? t("growth.flat")
                : t(bytesPerDay < 0 ? "growth.headlineLess" : "growth.headline", {
                    bytes: formatBytes(Math.abs(bytesPerDay), language),
                  })}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function LimitText({ tenant }: { tenant: CapacityTenant }) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  const { limit } = tenant;
  switch (limit.kind) {
    case "filesystem":
      return (
        <p data-limit="filesystem">
          {t("detail.limitFilesystem", {
            free: formatBytes(limit.freeBytes ?? 0, language),
            total: formatBytes(limit.totalBytes ?? 0, language),
          })}
        </p>
      );
    case "s3":
      return <p data-limit="s3">{t("detail.limitS3")}</p>;
    case "shared_default":
      return <p data-limit="shared_default">{t("detail.limitShared")}</p>;
    default:
      return <p data-limit="unknown">{t("detail.limitUnknown")}</p>;
  }
}

function Repositories({ detail }: { detail: CapacityTenantDetail }) {
  const { t } = useTranslation("resources");
  const groups = [
    ["machines", detail.machines, detail.omitted.machines],
    ["fileShares", detail.fileShares, detail.omitted.fileShares],
    ["guests", detail.guests, detail.omitted.guests],
  ] as const;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("detail.targets")}
        </h4>
        {detail.defaultRepository ? (
          <p data-slot="resources-default-repository">{t("detail.defaultRepository")}</p>
        ) : null}
        {detail.targets.length > 0 ? (
          <ul className="divide-y rounded-md border bg-background" data-slot="resources-targets">
            {detail.targets.map((target) => (
              <TargetRow key={target.id} target={target} />
            ))}
          </ul>
        ) : null}
      </div>
      {groups.map(([group, repositories, omitted]) =>
        repositories.length > 0 ? (
          <div key={group} className="space-y-1" data-group={group}>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(`detail.${group}`)}
            </h4>
            <ul className="divide-y rounded-md border bg-background">
              {repositories.map((repository) => (
                <RepositoryRow key={repository.id} repository={repository} />
              ))}
            </ul>
            {omitted > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("detail.omitted", { count: omitted })}
              </p>
            ) : null}
          </div>
        ) : null,
      )}
      <p className="text-xs text-muted-foreground">{t("detail.repositoriesNote")}</p>
    </div>
  );
}

function TargetRow({ target }: { target: CapacityTarget }) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  const known = ["ok", "error", "unverified"].includes(target.status);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-target={target.id}>
      <span className="font-medium">{t(`detail.${target.role}`)}</span>
      <span className="text-muted-foreground">{t(`detail.kind.${target.kind}`)}</span>
      {known ? (
        <StatusBadge tone={target.status === "error" ? "destructive" : "muted"}>
          {t(`detail.status.${target.status}`)}
        </StatusBadge>
      ) : null}
      <span className="ml-auto tabular-nums">
        {t("detail.used", { bytes: formatBytes(target.usedBytes, language) })}
      </span>
    </li>
  );
}

function RepositoryRow({ repository }: { repository: CapacityRepository }) {
  const { t } = useTranslation("resources");
  const language = useLanguage();
  const { growth } = repository;
  const measured = growth.days7 !== null || growth.days30 !== null || growth.days90 !== null;
  const horizon = growth.days30 !== null ? 30 : growth.days7 !== null ? 7 : 90;
  const rate = growth.days30 ?? growth.days7 ?? growth.days90;
  return (
    <li
      className="grid gap-x-3 gap-y-0.5 px-3 py-2"
      data-repository={repository.id}
      data-level={repository.level}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-medium">{repository.name}</span>
        {repository.level !== "ok" ? (
          <StatusBadge tone={repository.level === "exceeded" ? "destructive" : "warning"} icon>
            {t(`quota.${repository.level}`)}
          </StatusBadge>
        ) : null}
        <span className="ml-auto tabular-nums">
          {repository.usedBytes === null
            ? t("detail.notMeasured")
            : t("detail.used", { bytes: formatBytes(repository.usedBytes, language) })}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>
          {repository.budgetBytes === null
            ? t("detail.noBudget")
            : t("detail.budget", { bytes: formatBytes(repository.budgetBytes, language) })}
        </span>
        <span data-slot="repository-growth">
          {measured && rate !== null
            ? `${rate === 0 ? t("growth.flat") : t(rate < 0 ? "growth.headlineLess" : "growth.headline", { bytes: formatBytes(Math.abs(rate), language) })} (${t("growth.over", { days: horizon })})`
            : t("detail.growthPending")}
        </span>
      </div>
    </li>
  );
}
