import { Link } from "@tanstack/react-router";
import { ArrowRight, Pencil } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { installationSectionTo } from "@/features/installation/paths";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import type { PricingEstimate } from "./api.js";
import "./i18n.js";
import { formatMoney, formatQuantity, tenantPriceView } from "./presenters.js";
import { TenantPriceDialog } from "./tenant-price-dialog.js";

const LINK =
  "inline-flex items-center gap-1 rounded-sm text-xs text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/**
 * An amount per month: the amount large and never broken, the unit small after it (a narrow card
 * moves the unit to the next line rather than splitting the amount).
 */
export function PerMonth({ amount }: { amount: string }) {
  const { t } = useTranslation("pricing");
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
      <span className="text-2xl font-semibold whitespace-nowrap">{amount}</span>{" "}
      <span className="text-sm text-muted-foreground whitespace-nowrap">{t("card.perMonth")}</span>
    </span>
  );
}

/**
 * What a tenant comes to per month, the body of the price card on the dashboard and on the
 * tenant's overview (one source: the server's estimate, tenant-pricing.ts / pricing-estimate.ts):
 * the total, a line per price (quantity times price is the amount), a badge where the tenant has a
 * price of its own, the way to the installation's prices and, for the owner where tenants may
 * have prices of their own, the way to this tenant's prices. Figures that are not available yet
 * say so instead of making the card disappear.
 */
export function PriceBody({
  estimate,
  tenantId,
  tenantName,
}: {
  estimate: PricingEstimate;
  tenantId: string;
  tenantName: string;
}) {
  const { t, i18n } = useTranslation("pricing");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const session = useSession();
  const [editing, setEditing] = React.useState(false);
  const view = tenantPriceView(estimate, tenantId);
  const money = (value: number) => formatMoney(value, estimate.currency, language);
  const canEdit = estimate.perTenantOverrides && providerMay(session, "owner");

  return (
    <div className="flex flex-col items-start gap-1" data-slot="price-body" data-state={view.kind}>
      {view.kind === "ready" ? (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <PerMonth amount={money(view.total)} />
            {view.custom ? <Badge variant="secondary">{t("card.custom")}</Badge> : null}
          </div>
          {view.mailboxes ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {t("card.mailboxes", {
                count: view.mailboxes.quantity,
                price: money(view.mailboxes.price),
                amount: money(view.mailboxes.amount),
              })}
            </span>
          ) : null}
          {view.storage ? (
            <span className="text-xs text-muted-foreground tabular-nums" data-slot="storage-line">
              {view.storage.billed
                ? t("card.storageBilled", {
                    stored: formatQuantity(view.storage.billed.storedGb, language),
                    quantity: formatQuantity(view.storage.billed.quantity, language),
                    unit: view.storage.unit,
                    price: money(view.storage.price),
                    amount: money(view.storage.amount),
                  })
                : t("card.storage", {
                    quantity: formatQuantity(view.storage.quantity, language),
                    unit: view.storage.unit,
                    price: money(view.storage.price),
                    amount: money(view.storage.amount),
                  })}
            </span>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm text-muted-foreground">
            {view.kind === "unavailable" ? t("card.unavailable") : t("card.none")}
          </span>
          {view.kind === "unavailable" && view.custom ? (
            <Badge variant="secondary">{t("card.custom")}</Badge>
          ) : null}
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={installationSectionTo("pricing")} className={LINK}>
          {t("card.link")}
          <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
        {canEdit ? (
          <>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto gap-1 p-0 text-xs"
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden="true" className="size-3" />
              {t("card.edit")}
            </Button>
            <TenantPriceDialog
              tenantId={tenantId}
              tenantName={tenantName}
              open={editing}
              onOpenChange={setEditing}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
