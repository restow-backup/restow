import { Coins } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import "./i18n.js";
import { tenantPriceView } from "./presenters.js";
import { PriceBody } from "./price-body.js";
import { usePricingEstimate } from "./use-estimate.js";

/**
 * The tenant overview's price card (0.4.7, estimate from the server since 0.4.8): what the tenant
 * comes to per month at the provider's prices (installation section "Prices") or at its own
 * prices, its mailboxes and its stored backups. Only for the provider's admins, only once a price
 * applies (the owner, where tenants may have prices of their own, also sees it without one, to set
 * them); a figure to keep an eye on, nothing bills it. Figures that are not available yet say so.
 */
export function PriceCard({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const { t } = useTranslation("pricing");
  const session = useSession();
  const query = usePricingEstimate({ tenantId, enabled: session.isProviderAdmin });
  if (!session.isProviderAdmin) {
    return null;
  }
  const estimate = query.data;
  if (query.isError && !estimate) {
    return (
      <Card className="gap-3" data-slot="tenant-price-card" data-state="error">
        <CardContent>
          <ErrorState
            title={t("card.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </CardContent>
      </Card>
    );
  }
  // While it loads nothing is there yet: most installations have no price, and the row of
  // figures should not jump for them.
  if (!estimate) {
    return null;
  }
  const owner = estimate.perTenantOverrides && providerMay(session, "owner");
  if (tenantPriceView(estimate, tenantId).kind === "none" && !owner) {
    return null;
  }
  return (
    <Card className="gap-3" data-slot="tenant-price-card">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Coins className="size-4 text-muted-foreground" aria-hidden={true} />
        <CardTitle className="text-sm font-medium">{t("card.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <PriceBody estimate={estimate} tenantId={tenantId} tenantName={tenantName} />
      </CardContent>
    </Card>
  );
}
