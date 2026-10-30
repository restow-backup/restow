import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";

import {
  fetchTenantPricing,
  pricingKey,
  saveTenantPricing,
  type TenantPricing,
  tenantPricingKey,
} from "./api.js";
import "./i18n.js";
import { formatMoney, parsePrice, priceText } from "./presenters.js";

/**
 * The prices of one tenant (0.4.8, Service Provider): a price per mailbox and a price per GB or
 * TB that replace the installation's for this tenant alone. The currency and the unit stay the
 * installation's. An empty field takes the installation's price again ("use installation
 * price"). Only the owner opens it; the server decides (a refusal is shown in the dialog).
 */
export function TenantPriceDialog({
  tenantId,
  tenantName,
  open,
  onOpenChange,
}: {
  tenantId: string;
  tenantName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("pricing");
  const query = useQuery({
    queryKey: tenantPricingKey(tenantId),
    queryFn: () => fetchTenantPricing(tenantId),
    enabled: open,
    // The form starts from what the server has now, not from an older copy.
    staleTime: 0,
    retry: false,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="tenant-price-dialog">
        <DialogHeader>
          <DialogTitle>{t("editor.title", { name: tenantName })}</DialogTitle>
          <DialogDescription>
            {query.data
              ? t("editor.description", { currency: query.data.currency })
              : t("editor.descriptionBare")}
          </DialogDescription>
        </DialogHeader>
        {query.isError ? (
          <ErrorState
            title={t("editor.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : !query.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <TenantPriceForm
            pricing={query.data}
            tenantName={tenantName}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TenantPriceForm({
  pricing,
  tenantName,
  onDone,
}: {
  pricing: TenantPricing;
  tenantName: string;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation("pricing");
  const { t: tc } = useTranslation("common");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const queryClient = useQueryClient();
  const id = React.useId();
  const [mailbox, setMailbox] = React.useState(priceText(pricing.overrides.mailboxPrice, language));
  const [storage, setStorage] = React.useState(priceText(pricing.overrides.storagePrice, language));
  const mailboxPrice = parsePrice(mailbox);
  const storagePrice = parsePrice(storage);
  const valid = mailboxPrice !== undefined && storagePrice !== undefined;
  const changed =
    mailboxPrice !== pricing.overrides.mailboxPrice ||
    storagePrice !== pricing.overrides.storagePrice;
  const save = useMutation({
    mutationFn: () =>
      saveTenantPricing(pricing.tenantId, {
        mailboxPrice: mailboxPrice ?? null,
        storagePrice: storagePrice ?? null,
      }),
    onSuccess: async () => {
      // Every figure derived from the prices (the cards, the sum, the list in the installation
      // section) and the tenant's own prices.
      await queryClient.invalidateQueries({ queryKey: pricingKey });
      toast.success(t("editor.saved", { name: tenantName }));
      onDone();
    },
  });
  const disabled = !pricing.overridesEnabled || save.isPending;
  const money = (value: number | null) =>
    value === null ? null : formatMoney(value, pricing.currency, language);
  const installation = (value: number | null) => {
    const text = money(value);
    return text === null
      ? t("editor.installationNone")
      : t("editor.installationPrice", { price: text });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && changed && !disabled) {
          save.mutate();
        }
      }}
    >
      <PriceField
        id={`${id}-mailbox`}
        label={t("editor.mailbox")}
        value={mailbox}
        invalid={mailboxPrice === undefined}
        errorId={`${id}-error`}
        disabled={disabled}
        placeholder={priceText(pricing.global.mailboxPrice, language)}
        hint={installation(pricing.global.mailboxPrice)}
        onChange={setMailbox}
      />
      <PriceField
        id={`${id}-storage`}
        label={t("editor.storage", { unit: pricing.storageUnit })}
        value={storage}
        invalid={storagePrice === undefined}
        errorId={`${id}-error`}
        disabled={disabled}
        placeholder={priceText(pricing.global.storagePrice, language)}
        hint={installation(pricing.global.storagePrice)}
        onChange={setStorage}
      />
      {!valid ? (
        <p id={`${id}-error`} className="text-sm text-destructive-text" role="alert">
          {t("editor.invalid")}
        </p>
      ) : null}
      {!pricing.overridesEnabled ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>{t("editor.unavailable")}</AlertDescription>
        </Alert>
      ) : null}
      {save.error ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertDescription>{(save.error as Error).message}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending}>
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!valid || !changed || disabled}>
          {t("editor.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PriceField({
  id,
  label,
  value,
  invalid,
  errorId,
  disabled,
  placeholder,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  invalid: boolean;
  /** The message shown while `invalid`, which the input points at. */
  errorId: string;
  disabled: boolean;
  /** The installation's price, shown while the field is empty (that price applies). */
  placeholder: string;
  hint: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("pricing");
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-hint ${errorId}` : `${id}-hint`}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || value === ""}
          aria-label={t("editor.useInstallationFor", { field: label })}
          onClick={() => onChange("")}
        >
          {t("editor.useInstallation")}
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
