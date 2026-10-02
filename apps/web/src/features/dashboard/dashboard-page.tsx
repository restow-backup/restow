import { useNavigate, useSearch } from "@tanstack/react-router";
import { Building2, CloudOff, LayoutDashboard } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  EmptyState,
  ErrorState,
  PageHeader,
  RefreshButton,
  RelativeTime,
  StatusBadge,
} from "@/components/kit";
import { useSwitchTenant } from "@/components/tenant-switcher";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { STATS_VIEW, StatsPage } from "@/features/stats";
import { OwnOrganisationPrompt } from "@/features/tenants/components/own-organisation-prompt";
import { type ReadinessState, verifyLink } from "@/features/verify/search";
import { ExtensionSlot } from "@/lib/extensions";
import { sessionScope, useSession } from "@/lib/session";

import { OverviewTabs } from "./components/overview-tabs.js";
import { tenantDetailTo } from "./paths.js";
import { widgetView } from "./presenters.js";
import { useDashboard } from "./use-dashboard.js";
import { DashboardWidgets } from "./widget-registry.js";
import type { TrendWindow } from "./widgets/trend-widgets.js";
import "./i18n.js";

/**
 * Overview, the start page, with two tabs: Status (the dashboard below) and
 * Statistics (features/stats, `?view=statistics`, for administrators). The
 * tab bar sits above the header of the tab it shows. Under "All tenants" there
 * is only Status: statistics are a tenant's own.
 */
export function DashboardPage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const allTenants = sessionScope(useSession()) === "all";
  const statistics = raw.view === STATS_VIEW && !allTenants;
  return (
    <div className="space-y-6">
      {allTenants ? null : <OverviewTabs current={statistics ? "statistics" : "status"} />}
      {statistics ? <StatsPage /> : <StatusView allTenants={allTenants} />}
    </div>
  );
}

/**
 * The Status tab follows the tenant switcher. For a tenant it is that tenant's
 * widgets, one request, each with its own loading, empty and error state; a
 * failed refresh never passes old figures off as current. Under "All tenants"
 * (provider admins, where the installation offers it) it is the provider view
 * alone: the sum across the tenants and the tenants by what needs doing, where a
 * click switches into that tenant.
 */
function StatusView({ allTenants }: { allTenants: boolean }) {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const { tenants } = useSession();
  const switchTenant = useSwitchTenant();
  const dashboard = useDashboard(allTenants ? "all" : "tenant");
  const { query } = dashboard;
  const { refetch } = query;
  const [trendDays, setTrendDays] = React.useState<TrendWindow>(14);

  const refresh = React.useCallback(() => void refetch(), [refetch]);
  const openTenant = React.useCallback(
    (tenantId: string) => {
      const tenant = tenants.find((candidate) => candidate.id === tenantId);
      if (tenant) {
        switchTenant(tenant);
      }
    },
    [switchTenant, tenants],
  );
  const openReadiness = React.useCallback(
    (tenantId: string, state: ReadinessState) => {
      openTenant(tenantId);
      void navigate(verifyLink(state) as never);
    },
    [navigate, openTenant],
  );
  const tenantDetails = React.useCallback(
    (tenantId: string) => void navigate({ to: tenantDetailTo(tenantId) }),
    [navigate],
  );

  const data = query.data;
  const loading = query.isPending;
  const retrying = query.isFetching;

  let body: React.ReactNode;
  if (dashboard.noTenant) {
    // Before any tenant exists, a provider admin is asked to set up the own organisation.
    body =
      dashboard.ownOrganisation?.kind === "setUp" ? (
        <OwnOrganisationPrompt prompt={dashboard.ownOrganisation} variant="empty" />
      ) : (
        <EmptyState
          icon={Building2}
          title={t("noTenant.title")}
          description={t("noTenant.description")}
        />
      );
  } else if (query.isError && !data) {
    body = (
      <ErrorState
        title={t("error.title")}
        error={query.error}
        onRetry={refresh}
        retrying={retrying}
      />
    );
  } else {
    body = allTenants ? (
      <ExtensionSlot
        name="dashboard.provider"
        props={{
          view: widgetView(data?.provider ?? undefined, loading),
          onRetry: refresh,
          retrying,
          onOpenTenant: openTenant,
          onTenantDetails: tenantDetails,
          onOpenReadiness: openReadiness,
        }}
      />
    ) : (
      <DashboardWidgets
        widgets={data?.widgets}
        loading={loading}
        onRetry={refresh}
        retrying={retrying}
        canAdminister={dashboard.canAdminister}
        isProviderAdmin={dashboard.isProviderAdmin}
        trendDays={trendDays}
        onTrendDaysChange={setTrendDays}
      />
    );
  }

  const description = allTenants ? (
    t("providerScope")
  ) : dashboard.tenantName ? (
    <span className="flex flex-wrap items-center gap-2">
      {t("tenantScope", { tenant: dashboard.tenantName })}
      {data?.tenant.status === "suspended" ? (
        <StatusBadge tone="muted">{t("suspended")}</StatusBadge>
      ) : null}
    </span>
  ) : (
    t("subtitle")
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={description}
        icon={LayoutDashboard}
        actions={
          dashboard.noTenant ? null : (
            <div className="flex items-center gap-3">
              {data ? (
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {t("updated")} <RelativeTime value={data.generatedAt} />
                </span>
              ) : null}
              <RefreshButton onRefresh={refresh} fetching={query.isFetching} variant="outline" />
            </div>
          )
        }
      />

      {dashboard.ownOrganisation && !dashboard.noTenant ? (
        <OwnOrganisationPrompt prompt={dashboard.ownOrganisation} variant="banner" />
      ) : null}

      {query.isError && data ? (
        <Alert variant="warning">
          <CloudOff />
          <AlertTitle>{t("stale.title")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {t("stale.description")} <RelativeTime value={data.generatedAt} />
            </span>
            <Button variant="outline" size="sm" onClick={refresh} loading={retrying}>
              {t("stale.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {body}
    </div>
  );
}
