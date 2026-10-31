import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowRight, Coins } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RESOURCES_PATH } from "@/features/resources/paths";
import { useSession } from "@/lib/session";

import "./i18n.js";
import { formatMoney, topTenants } from "./presenters.js";
import { PerMonth } from "./price-body.js";
import { usePricingEstimate } from "./use-estimate.js";

/** Tenants named in the card; the rest is counted ("+N more"). The card never lists more. */
export const ALL_TENANTS_TOP = 5;

/**
 * Where the card's "All tenants" leads: the capacity page with the monthly amount per tenant,
 * dearest first (its sortable "Price per month" column, there once a price is set).
 */
const FULL_LIST = {
  to: RESOURCES_PATH as LinkProps["to"],
  // Feature routes join the router at runtime: the static typing cannot know their search.
  search: { sort: "price" } as never,
};

/**
 * Whether the "All tenants" page has a price card: a provider admin, and an installation with a
 * price (or an estimate that failed, which the card says). The page lays out its first row by
 * it, so the readiness card is not left beside an empty cell. Shares the card's query; `active`
 * is false outside "All tenants", where nothing is asked.
 */
export function useAllTenantsPriceVisible(active: boolean): boolean {
  const session = useSession();
  const query = usePricingEstimate({ enabled: active && session.isProviderAdmin });
  if (!active || !session.isProviderAdmin) {
    return false;
  }
  return query.data ? query.data.hasPrices : query.isError;
}

/**
 * "All tenants" view of the dashboard (0.4.8): what the customers come to per month in total at
 * the provider's prices (and their own), and the five that come to the most; a click switches
 * into that tenant. Only for a provider admin, only once a price is set. A tenant whose figures
 * are not available is left out of the sum and said so, never counted as nothing. The operator's
 * own organisation is no customer and not in it.
 *
 * It is a narrow card beside the readiness card and never grows with the number of tenants: the
 * total, at most {@link ALL_TENANTS_TOP} tenants (names cut short with the full name as a tooltip,
 * amounts right-aligned), how many more there are, and the way to the full list.
 */
export function AllTenantsPriceCard({
  onOpenTenant,
}: {
  onOpenTenant: (tenantId: string) => void;
}) {
  const { t, i18n } = useTranslation("pricing");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const session = useSession();
  const query = usePricingEstimate({ enabled: session.isProviderAdmin });
  const estimate = query.data;
  if (session.isProviderAdmin && query.isError && !estimate) {
    // A failed read says so, like the tenant's card: a missing card would pass for "no price set".
    return (
      <Card className="h-full gap-3" data-widget="allTenantsPrice" data-state="error">
        <CardContent>
          <ErrorState
            title={t("all.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </CardContent>
      </Card>
    );
  }
  // Nothing while it loads: a summary on top of the page, not worth a gap.
  if (!session.isProviderAdmin || !estimate?.hasPrices) {
    return null;
  }
  const money = (value: number) => formatMoney(value, estimate.currency, language);
  const { top, more } = topTenants(estimate, ALL_TENANTS_TOP);
  return (
    <Card className="h-full gap-3" data-widget="allTenantsPrice">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t("all.title")}
        </CardTitle>
        <CardDescription>{t("all.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="space-y-1">
          {estimate.total !== null ? (
            <p data-slot="all-total">
              <PerMonth amount={money(estimate.total)} />
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("all.unavailable")}</p>
          )}
          {estimate.missing > 0 ? (
            <p className="text-xs text-muted-foreground" data-slot="all-missing">
              {t("all.missing", { count: estimate.missing })}
            </p>
          ) : null}
        </div>
        {top.length > 0 ? (
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{t("all.top")}</p>
            <ul className="divide-y text-sm" data-slot="all-top">
              {top.map((tenant) => (
                <li key={tenant.tenantId} className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    title={tenant.name}
                    onClick={() => onOpenTenant(tenant.tenantId)}
                    className="min-w-0 truncate rounded-sm py-1 text-left text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {tenant.name}
                  </button>
                  <span className="shrink-0 text-right tabular-nums">
                    {money(tenant.amount.total ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {more > 0 ? (
            <p className="text-xs text-muted-foreground" data-slot="all-more">
              {t("all.more", { count: more })}
            </p>
          ) : (
            <span />
          )}
          <Link
            {...FULL_LIST}
            title={t("all.listTitle")}
            data-slot="all-list"
            className="inline-flex items-center gap-1 rounded-sm text-xs text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("all.list")}
            <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
