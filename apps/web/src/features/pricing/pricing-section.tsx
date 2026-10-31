import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState, NativeSelect } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";
import { tenantPageTo } from "@/lib/tenant-paths";

import {
  fetchPricing,
  PRICING_CURRENCIES,
  type Pricing,
  type PricingEstimate,
  pricingKey,
  savePricing,
} from "./api.js";
import { formatMoney, parsePrice, priceText, tenantsWithOwnPrices } from "./presenters.js";
import { usePricingEstimate } from "./use-estimate.js";

/**
 * The provider's prices (installation section, 0.4.7): per month, per gigabyte or terabyte of
 * stored backups and per protected mailbox. The tenant overview shows what a tenant comes to at
 * these prices, in a small card for the provider; nothing bills or limits anything. Every
 * provider admin reads them, the owner changes them.
 */
export function PricingSection() {
  const { t } = useTranslation("installation");
  const session = useSession();
  // The page is for provider admins already (installation/installation-page.tsx); nobody else
  // asks for a price even if the section is mounted elsewhere.
  const query = useQuery({
    queryKey: pricingKey,
    queryFn: fetchPricing,
    enabled: session.isProviderAdmin,
  });
  if (!session.isProviderAdmin) {
    return null;
  }
  return (
    <Card data-slot="pricing-settings">
      <CardHeader>
        <CardTitle className="text-base">{t("pricing.title")}</CardTitle>
        <CardDescription>{t("pricing.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <ErrorState
            title={t("pricing.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : !query.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-6">
            <PricingForm pricing={query.data} />
            <TenantsWithOwnPrices />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Where tenants may have prices of their own (Service Provider, 0.4.8): which tenants do, from
 * the server's estimate, and where to set them (the price card of the tenant's overview, for the
 * owner). Nothing where the installation has a single tenant.
 */
function TenantsWithOwnPrices() {
  const { t, i18n } = useTranslation("installation");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const session = useSession();
  const query = usePricingEstimate({ enabled: session.isProviderAdmin });
  if (query.isError && !query.data) {
    return (
      <p className="text-sm text-muted-foreground" role="alert">
        {t("pricing.overrides.loadError")}
      </p>
    );
  }
  const estimate = query.data;
  if (!estimate?.perTenantOverrides) {
    return null;
  }
  return (
    <section
      className="space-y-2 border-t pt-4"
      aria-labelledby="tenants-own-prices"
      data-slot="tenants-own-prices"
    >
      <h3 id="tenants-own-prices" className="text-sm font-medium">
        {t("pricing.overrides.title")}
      </h3>
      <OwnPriceList estimate={estimate} language={language} />
      <p className="text-xs text-muted-foreground">{t("pricing.overrides.hint")}</p>
    </section>
  );
}

function OwnPriceList({ estimate, language }: { estimate: PricingEstimate; language: string }) {
  const { t } = useTranslation("installation");
  const tenants = tenantsWithOwnPrices(estimate);
  if (tenants.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("pricing.overrides.empty")}</p>;
  }
  const money = (value: number) => formatMoney(value, estimate.currency, language);
  return (
    <ul className="divide-y text-sm">
      {tenants.map((tenant) => (
        <li
          key={tenant.tenantId}
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
        >
          <Link
            to={tenantPageTo(tenant.tenantId, "overview")}
            className="rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {tenant.name}
          </Link>
          <span className="text-xs text-muted-foreground tabular-nums">
            {[
              tenant.overridden.mailbox && tenant.mailboxPrice !== null
                ? t("pricing.overrides.mailbox", { price: money(tenant.mailboxPrice) })
                : null,
              tenant.overridden.storage && tenant.storagePrice !== null
                ? t("pricing.overrides.storage", {
                    price: money(tenant.storagePrice),
                    unit: estimate.storageUnit,
                  })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PricingForm({ pricing }: { pricing: Pricing }) {
  const { t, i18n } = useTranslation("installation");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const session = useSession();
  const canChange = providerMay(session, "owner");
  const queryClient = useQueryClient();
  const id = React.useId();
  const [currency, setCurrency] = React.useState(pricing.currency);
  const [unit, setUnit] = React.useState(pricing.storageUnit);
  const [storage, setStorage] = React.useState(priceText(pricing.storagePrice, language));
  const [mailbox, setMailbox] = React.useState(priceText(pricing.mailboxPrice, language));
  const storagePrice = parsePrice(storage);
  const mailboxPrice = parsePrice(mailbox);
  const valid = storagePrice !== undefined && mailboxPrice !== undefined;
  const changed =
    currency !== pricing.currency ||
    unit !== pricing.storageUnit ||
    storagePrice !== pricing.storagePrice ||
    mailboxPrice !== pricing.mailboxPrice;
  const save = useMutation({
    mutationFn: () =>
      savePricing({
        currency,
        storageUnit: unit,
        storagePrice: storagePrice ?? null,
        mailboxPrice: mailboxPrice ?? null,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(pricingKey, data);
      // Every figure derived from the prices (the cards, the sum, the list of own prices) is
      // stale now; the pricing itself was just set.
      void queryClient.invalidateQueries({ queryKey: [...pricingKey, "estimate"] });
      toast.success(t("pricing.saved"));
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const disabled = !canChange || save.isPending;
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && changed) {
          save.mutate();
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-mailbox`} className="text-sm font-medium">
            {t("pricing.mailbox")}
          </label>
          <Input
            id={`${id}-mailbox`}
            inputMode="decimal"
            placeholder={t("pricing.none")}
            value={mailbox}
            disabled={disabled}
            aria-invalid={mailboxPrice === undefined}
            onChange={(event) => setMailbox(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("pricing.mailboxHint")}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-storage`} className="text-sm font-medium">
            {t("pricing.storage")}
          </label>
          <div className="flex gap-2">
            <Input
              id={`${id}-storage`}
              inputMode="decimal"
              placeholder={t("pricing.none")}
              value={storage}
              disabled={disabled}
              aria-invalid={storagePrice === undefined}
              onChange={(event) => setStorage(event.target.value)}
            />
            <NativeSelect
              className="w-auto"
              aria-label={t("pricing.unit")}
              value={unit}
              disabled={disabled}
              onChange={(event) => setUnit(event.target.value as Pricing["storageUnit"])}
            >
              <option value="GB">{t("pricing.perGb")}</option>
              <option value="TB">{t("pricing.perTb")}</option>
            </NativeSelect>
          </div>
          <p className="text-xs text-muted-foreground">{t("pricing.storageHint")}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-currency`} className="text-sm font-medium">
            {t("pricing.currency")}
          </label>
          <NativeSelect
            id={`${id}-currency`}
            className="block w-auto"
            value={currency}
            disabled={disabled}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {PRICING_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </NativeSelect>
        </div>
        {canChange ? (
          <Button type="submit" disabled={!valid || !changed || save.isPending}>
            {t("pricing.save")}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t("pricing.ownerOnly")}</p>
        )}
      </div>
      {!valid ? (
        <p className="text-sm text-destructive-text" role="alert">
          {t("pricing.invalid")}
        </p>
      ) : null}
    </form>
  );
}
