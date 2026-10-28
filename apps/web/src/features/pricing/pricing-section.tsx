import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import { fetchPricing, PRICING_CURRENCIES, type Pricing, pricingKey, savePricing } from "./api.js";

const SELECT =
  "h-9 rounded-md border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50";

/** A price as typed ("2,50", "0.02", empty = none); undefined when it is no price. */
export function parsePrice(text: string): number | null | undefined {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") {
    return null;
  }
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value <= 1_000_000 ? value : undefined;
}

function priceText(value: number | null, language: string): string {
  return value === null
    ? ""
    : new Intl.NumberFormat(language, { maximumFractionDigits: 4, useGrouping: false }).format(
        value,
      );
}

/**
 * The provider's prices (installation section, 0.4.7): per month, per gigabyte or terabyte of
 * stored backups and per protected mailbox. The tenant overview shows what a tenant comes to at
 * these prices, in a small card for the provider; nothing bills or limits anything. Every
 * provider admin reads them, the owner changes them.
 */
export function PricingSection() {
  const { t } = useTranslation("installation");
  const query = useQuery({ queryKey: pricingKey, queryFn: fetchPricing });
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
          <PricingForm pricing={query.data} />
        )}
      </CardContent>
    </Card>
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
            <select
              className={SELECT}
              aria-label={t("pricing.unit")}
              value={unit}
              disabled={disabled}
              onChange={(event) => setUnit(event.target.value as Pricing["storageUnit"])}
            >
              <option value="GB">{t("pricing.perGb")}</option>
              <option value="TB">{t("pricing.perTb")}</option>
            </select>
          </div>
          <p className="text-xs text-muted-foreground">{t("pricing.storageHint")}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-currency`} className="text-sm font-medium">
            {t("pricing.currency")}
          </label>
          <select
            id={`${id}-currency`}
            className={`${SELECT} block`}
            value={currency}
            disabled={disabled}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {PRICING_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
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
