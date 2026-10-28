import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Coins } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { installationSectionTo } from "@/features/installation/paths";
import { useSession } from "@/lib/session";

import { fetchPricing, pricingKey } from "./api.js";
import { formatMoney, priceEstimate } from "./presenters.js";

/**
 * The tenant overview's price card (0.4.7): what the tenant comes to per month at the provider's
 * prices (installation section "Prices"), its mailboxes and its stored backups. Only for the
 * provider's admins, only once a price is set; a figure to keep an eye on, nothing bills it.
 */
export function PriceCard({
  mailboxes,
  storedBytes,
}: {
  /** Protected mailboxes of the tenant; null while unknown. */
  mailboxes: number | null;
  /** The tenant's stored backups (deduplicated, compressed); null while unknown. */
  storedBytes: number | null;
}) {
  const { t, i18n } = useTranslation("tenantpage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const session = useSession();
  const query = useQuery({
    queryKey: pricingKey,
    queryFn: fetchPricing,
    enabled: session.isProviderAdmin,
    staleTime: 60_000,
    retry: false,
  });
  const pricing = query.data;
  const estimate = priceEstimate(pricing, mailboxes, storedBytes);
  if (!session.isProviderAdmin || !pricing || !estimate) {
    return null;
  }
  const money = (value: number) => formatMoney(value, pricing.currency, language);
  const amount = (value: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
  return (
    <Card className="gap-3" data-slot="tenant-price-card">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Coins className="size-4 text-muted-foreground" aria-hidden={true} />
        <CardTitle className="text-sm font-medium">{t("overview.price.title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-1">
        <span className="text-2xl font-semibold tabular-nums">
          {t("overview.price.perMonth", { amount: money(estimate.total) })}
        </span>
        {estimate.mailboxes ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("overview.price.mailboxes", {
              count: estimate.mailboxes.quantity,
              price: money(estimate.mailboxes.price),
              amount: money(estimate.mailboxes.amount),
            })}
          </span>
        ) : null}
        {estimate.storage ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("overview.price.storage", {
              quantity: amount(estimate.storage.quantity),
              unit: estimate.storage.unit,
              price: money(estimate.storage.price),
              amount: money(estimate.storage.amount),
            })}
          </span>
        ) : null}
        <Link
          to={installationSectionTo("pricing")}
          className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("overview.price.link")}
          <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      </CardContent>
    </Card>
  );
}
