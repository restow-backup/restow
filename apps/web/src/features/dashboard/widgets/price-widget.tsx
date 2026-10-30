import { Coins } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import type { PricingEstimate } from "@/features/pricing/api";
import { PriceBody } from "@/features/pricing/price-body";

import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";

function PriceSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-36" />
    </div>
  );
}

/**
 * What the active tenant comes to per month at the provider's prices (or its own), next to the
 * last successful backup. The figures come from the server's estimate, the same as the tenant
 * overview's price card; the page shows the card only for a provider admin whose installation has
 * a price (widget-registry.tsx). Nothing bills it.
 */
export function PriceWidget({
  tenantId,
  tenantName,
  ...props
}: WidgetStateProps<PricingEstimate> & { tenantId: string; tenantName: string }) {
  const { t } = useTranslation("pricing");
  return (
    <WidgetCard
      id="price"
      {...props}
      title={t("card.title")}
      icon={Coins}
      skeleton={<PriceSkeleton />}
    >
      {(estimate) => <PriceBody estimate={estimate} tenantId={tenantId} tenantName={tenantName} />}
    </WidgetCard>
  );
}
