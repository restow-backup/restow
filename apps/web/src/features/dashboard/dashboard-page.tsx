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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { STATS_VIEW, StatsPage } from "@/features/stats";
import { ExtensionSlot } from "@/lib/extensions";

import { LinkButton } from "./components/link-button.js";
import { OverviewTabs } from "./components/overview-tabs.js";
import { PATHS, tenantDetailTo, to } from "./paths.js";
import { overviewScope, widgetView } from "./presenters.js";
import { type DashboardTab, useDashboard } from "./use-dashboard.js";
import { DashboardWidgets } from "./widget-registry.js";
import type { TrendWindow } from "./widgets/trend-widgets.js";
import "./i18n.js";

/**
 * Overview, the start page, with two tabs: Status (the dashboard below) and
 * Statistics (features/stats, `?view=statistics`, for administrators). The
 * tab bar sits above the header of the tab it shows.
 */
export function DashboardPage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const statistics = raw.view === STATS_VIEW;
  return (
    <div className="space-y-6">
      <OverviewTabs current={statistics ? "statistics" : "status"} />
      {statistics ? <StatsPage /> : <StatusView />}
    </div>
  );
}

/**
 * The Status tab: one request per view, the widgets that apply to the
 * viewer, and for provider admins where the installation offers it a provider
 * view next to the active tenant. Every widget has its own loading, empty
 * and error state; a failed refresh never passes old figures off as current.
 */
function StatusView() {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const [tab, setTab] = React.useState<DashboardTab>("provider");
  const dashboard = useDashboard(tab);
  const { query, setActiveTenant } = dashboard;
  const { refetch } = query;
  const [trendDays, setTrendDays] = React.useState<TrendWindow>(14);

  const refresh = React.useCallback(() => void refetch(), [refetch]);
  const openTenant = React.useCallback(
    (tenantId: string) => {
      setActiveTenant(tenantId);
      setTab("tenant");
    },
    [setActiveTenant],
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
    body = (
      <EmptyState
        icon={Building2}
        title={t("noTenant.title")}
        description={
          dashboard.firstTenantPending ? t("noTenant.firstTenant") : t("noTenant.description")
        }
        actions={
          dashboard.firstTenantPending ? (
            <LinkButton to={to(PATHS.tenants)}>{t("noTenant.openTenants")}</LinkButton>
          ) : undefined
        }
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
    const tenantWidgets = (
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
    body = dashboard.provider ? (
      <Tabs value={tab} onValueChange={(value) => setTab(value as DashboardTab)} className="gap-6">
        <TabsList aria-label={t("tabs.label")}>
          <TabsTrigger value="provider">{t("tabs.provider")}</TabsTrigger>
          <TabsTrigger value="tenant" className="max-w-64">
            <span className="truncate">{dashboard.tenantName ?? t("tabs.tenant")}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="provider">
          <ExtensionSlot
            name="dashboard.provider"
            props={{
              view: widgetView(data?.provider ?? undefined, loading),
              onRetry: refresh,
              retrying,
              onOpenTenant: openTenant,
              onTenantDetails: tenantDetails,
            }}
          />
        </TabsContent>
        <TabsContent value="tenant">{tenantWidgets}</TabsContent>
      </Tabs>
    ) : (
      tenantWidgets
    );
  }

  const scope = overviewScope({
    provider: dashboard.provider,
    tab,
    noTenant: dashboard.noTenant,
    tenantName: dashboard.tenantName,
  });
  const description =
    scope === "provider" ? (
      t("providerScope")
    ) : scope === "tenant" ? (
      <span className="flex flex-wrap items-center gap-2">
        {t("tenantScope", { tenant: dashboard.tenantName ?? "" })}
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
