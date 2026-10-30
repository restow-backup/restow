import { Coins } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSession } from "@/lib/session";

import "./i18n.js";
import { formatMoney, topTenants } from "./presenters.js";
import { PerMonth } from "./price-body.js";
import { usePricingEstimate } from "./use-estimate.js";

/** Tenants named in the card; the rest is counted ("+N more"). */
export const ALL_TENANTS_TOP = 5;

/**
 * "All tenants" view of the dashboard (0.4.8): what the customers come to per month in total at
 * the provider's prices (and their own), and the five that come to the most; a click switches
 * into that tenant. Only for a provider admin, only once a price is set. A tenant whose figures
 * are not available is left out of the sum and said so, never counted as nothing. The operator's
 * own organisation is no customer and not in it.
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
  // Nothing while it loads or when it failed: a summary on top of the page, not worth a gap.
  if (!session.isProviderAdmin || !estimate?.hasPrices) {
    return null;
  }
  const money = (value: number) => formatMoney(value, estimate.currency, language);
  const { top, more } = topTenants(estimate, ALL_TENANTS_TOP);
  return (
    <Card className="gap-3" data-widget="allTenantsPrice">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("all.title")}
        </CardTitle>
        <CardDescription>{t("all.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-[auto_1fr] sm:gap-8">
        <div className="space-y-1">
          {estimate.total !== null ? (
            <p data-slot="all-total">
              <PerMonth amount={money(estimate.total)} />
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t("all.unavailable")}</p>
          )}
          {estimate.missing > 0 ? (
            <p className="max-w-xs text-xs text-muted-foreground" data-slot="all-missing">
              {t("all.missing", { count: estimate.missing })}
            </p>
          ) : null}
        </div>
        {top.length > 0 ? (
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("all.top")}</p>
            <ul className="divide-y text-sm">
              {top.map((tenant) => (
                <li key={tenant.tenantId} className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onOpenTenant(tenant.tenantId)}
                    className="min-w-0 truncate rounded-sm py-1.5 text-left text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {tenant.name}
                  </button>
                  <span className="shrink-0 tabular-nums">{money(tenant.amount.total ?? 0)}</span>
                </li>
              ))}
            </ul>
            {more > 0 ? (
              <p className="text-xs text-muted-foreground">{t("all.more", { count: more })}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
