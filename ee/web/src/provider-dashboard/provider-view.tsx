import {
  Building2,
  CircleAlert,
  HardDrive,
  KeyRound,
  type LucideIcon,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, type KpiDelta, KpiTile } from "@/components/kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProviderView as ProviderData, ProviderKpis } from "@/features/dashboard/api";
import { LinkButton } from "@/features/dashboard/components/link-button";
import { PATHS, to } from "@/features/dashboard/paths";
import type { WidgetView } from "@/features/dashboard/presenters";
import type { ReadinessState } from "@/features/verify/search";
import { formatBytes, formatInteger } from "@/lib/format";
import { AlertList } from "./alert-list.js";
import { ProviderReadinessCard } from "./readiness-card.js";
import { TenantMatrix } from "./tenant-matrix.js";
import "@/features/dashboard/i18n";

interface ProviderViewProps {
  view: WidgetView<ProviderData>;
  onRetry: () => void;
  retrying: boolean;
  onOpenTenant: (tenantId: string) => void;
  onTenantDetails: (tenantId: string) => void;
  onOpenReadiness: (tenantId: string, state: ReadinessState) => void;
  /** The price card of the page (null where there is none); it sits beside the readiness card. */
  priceCard: React.ReactNode;
  /** "Running now" of the page, laid out under the first row. */
  runningNow: React.ReactNode;
}

const KPI_KEYS = ["tenants", "notReady", "unverified", "failures", "mailboxes", "stored"] as const;
type KpiKey = (typeof KPI_KEYS)[number];

/** Tiles whose value sums tenant figures, so tenants that could not be read are missing from it. */
const SUMMED_KPIS: ReadonlySet<KpiKey> = new Set(["notReady", "unverified", "failures", "stored"]);

interface TileView {
  icon: LucideIcon;
  value: string;
  hint: string | null;
  delta?: KpiDelta | null;
}

/** A tile's hint, plus a plain note when its sum leaves out tenants that could not be read. */
function tileHint(hint: string | null, incomplete: string | null): React.ReactNode {
  if (!incomplete) {
    return hint;
  }
  return (
    <>
      {hint ? <span className="block">{hint}</span> : null}
      <span className="block font-medium text-warning-text" data-flag="incomplete">
        {incomplete}
      </span>
    </>
  );
}

function ProviderKpiTiles({ kpis, loading }: { kpis: ProviderKpis | null; loading: boolean }) {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const count = (value: number) => formatInteger(value, language);
  const tiles: Record<KpiKey, TileView> = {
    // The provider's customers: its own organisation is not one of them (and says so).
    tenants: {
      icon: Building2,
      value: kpis ? count(kpis.tenants) : "",
      hint: kpis ? t("provider.kpis.tenantsHint", { count: kpis.suspendedTenants }) : null,
    },
    notReady: {
      icon: ShieldAlert,
      value: kpis ? count(kpis.tenantsNotReady) : "",
      hint: kpis ? t("provider.kpis.notReadyHint", { count: kpis.tenants }) : null,
    },
    unverified: {
      icon: TriangleAlert,
      value: kpis ? count(kpis.unverifiedObjects) : "",
      hint: t("provider.kpis.unverifiedHint"),
    },
    failures: {
      icon: CircleAlert,
      value: kpis ? count(kpis.failures24h) : "",
      hint: t("provider.kpis.failuresHint"),
      delta: kpis
        ? {
            value: kpis.failures24h - kpis.failuresPrevious24h,
            format: count,
            higherIsBetter: false,
            period: t("provider.kpis.failuresPeriod"),
          }
        : null,
    },
    mailboxes: {
      icon: KeyRound,
      value: kpis ? count(kpis.mailboxes) : "",
      hint: null,
    },
    stored: {
      icon: HardDrive,
      value: kpis ? formatBytes(kpis.physicalBytes, language) : "",
      hint: kpis
        ? `${t("provider.kpis.storedHint")} ${t("provider.kpis.immutableHint", {
            count: kpis.tenantsWithImmutableBackups ?? 0,
          })}`
        : t("provider.kpis.storedHint"),
    },
  };
  const missing = kpis?.unavailableTenants ?? 0;
  const incomplete = missing > 0 ? t("provider.kpis.incomplete", { count: missing }) : null;

  return (
    // Columns by the width of the widget area (a container query), so a collapsed sidebar counts.
    <div className="grid gap-4 @[26rem]/widgets:grid-cols-2 @[56rem]/widgets:grid-cols-3">
      {KPI_KEYS.map((key) => (
        <KpiTile
          key={key}
          label={t(`provider.kpis.${key}`)}
          icon={tiles[key].icon}
          value={tiles[key].value}
          delta={tiles[key].delta}
          hint={tileHint(tiles[key].hint, SUMMED_KPIS.has(key) ? incomplete : null)}
          loading={loading}
        />
      ))}
    </div>
  );
}

/**
 * The first row: the readiness card with the price card beside it, both at the full height of the
 * row. As on the tenant's Status tab the width of the widget area decides (a container query on
 * `@container/widgets`, so a collapsed sidebar counts): from 68rem the readiness card takes two
 * thirds and the price card the third; from 42rem a little more than half and the rest; narrower,
 * the price card below the readiness card. Without a price card the readiness card has the row.
 */
function StatusRow({ main, aside }: { main: React.ReactNode; aside: React.ReactNode }) {
  if (!aside) {
    return <>{main}</>;
  }
  return (
    <div
      data-section="provider-status"
      className="grid gap-4 *:min-w-0 @[42rem]/widgets:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] @[68rem]/widgets:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
    >
      {/* One shrinkable track, so the card fills the height of its row. */}
      <div data-slot="widget-cell" className="grid grid-cols-1">
        {main}
      </div>
      <div data-slot="widget-cell" className="grid grid-cols-1">
        {aside}
      </div>
    </div>
  );
}

function MatrixCard({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("dashboard");
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t("provider.matrix.title")}</CardTitle>
        <CardDescription>{t("provider.matrix.description")}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

/**
 * The overview under "All tenants" (Service Provider edition, provider admins
 * only): the recovery readiness summed over every tenant with the price card beside
 * it, what is running now, provider-wide figures, alerts across tenants and the
 * tenants by what needs doing. Figures are read one tenant at a time on the server.
 * The operator's own organisation is in the sums and in the table, but is not
 * counted as a customer.
 */
export function ProviderView({
  view,
  onRetry,
  retrying,
  onOpenTenant,
  onTenantDetails,
  onOpenReadiness,
  priceCard,
  runningNow,
}: ProviderViewProps) {
  const { t } = useTranslation("dashboard");

  if (view.kind === "error") {
    return (
      <div data-widget="provider" data-state="error" className="@container/widgets space-y-6">
        <StatusRow
          main={
            <ErrorState
              title={t("provider.error.title")}
              description={t("widget.error.description")}
              error={view.error}
              onRetry={onRetry}
              retrying={retrying}
            />
          }
          aside={priceCard}
        />
        {runningNow}
      </div>
    );
  }

  if (view.kind === "loading") {
    return (
      <div data-widget="provider" data-state="loading" className="@container/widgets space-y-6">
        <StatusRow main={<ProviderReadinessCard readiness={null} loading />} aside={priceCard} />
        {runningNow}
        <ProviderKpiTiles kpis={null} loading />
        <MatrixCard>
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-8 w-64" />
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-10 w-full" />
            ))}
            <span className="sr-only">{t("provider.loading")}</span>
          </div>
        </MatrixCard>
      </div>
    );
  }

  const { data } = view;
  if (data.tenants.length === 0) {
    return (
      <div data-widget="provider" data-state="empty" className="@container/widgets space-y-6">
        {priceCard}
        {runningNow}
        <EmptyState
          icon={Building2}
          title={t("provider.empty.title")}
          description={t("provider.empty.description")}
          actions={<LinkButton to={to(PATHS.tenants)}>{t("provider.empty.action")}</LinkButton>}
        />
      </div>
    );
  }

  return (
    <div data-widget="provider" data-state="ready" className="@container/widgets space-y-6">
      <StatusRow
        main={<ProviderReadinessCard readiness={data.kpis.readiness} loading={false} />}
        aside={priceCard}
      />
      {runningNow}
      <ProviderKpiTiles kpis={data.kpis} loading={false} />
      <AlertList alerts={data.alerts} onOpenTenant={onOpenTenant} />
      <MatrixCard>
        <TenantMatrix
          rows={data.tenants}
          onOpenTenant={onOpenTenant}
          onTenantDetails={onTenantDetails}
          onOpenReadiness={onOpenReadiness}
        />
      </MatrixCard>
    </div>
  );
}
