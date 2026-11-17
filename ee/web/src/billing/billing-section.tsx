import { Download, Plus, Receipt } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, EmptyState, ErrorState, NativeSelect } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { AccessNote, useInstallationAccess } from "@/features/installation/access";
import { downloadFile } from "@/features/stats/download";
import { errorMessageKey } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import {
  type BillingLineType,
  type BillingPeriod,
  type BillingPeriodList,
  type BillingPeriodTenant,
  billingCsvPath,
} from "./api";
import { useBillingPeriod, useBillingPeriods, useCreateCorrection } from "./hooks";
import { BILLING_NAMESPACE } from "./i18n";
import {
  formatDay,
  formatMoney,
  formatPeriod,
  formatQuantity,
  hasGaps,
  lineKey,
  parseAmount,
  unitKey,
} from "./presenters";

const LINE_TYPES: readonly BillingLineType[] = [
  "mailboxes",
  "storage",
  "servers",
  "clients",
  "vms",
  "containers",
  "fileShares",
];

/**
 * Installation › Billing (0.6.0, Service Provider): the months of the billing close. The list
 * names the open month with the day it closes and every closed month with its total; a closed
 * month shows per tenant each line at its peak with the day of the peak and the price of the
 * month's end, the days sampled against the days of the month, the corrections, and a CSV export.
 * Every provider role reads; only the owner enters a correction (`billing.correction.created`).
 * Neutral and Lapis tones only: a closed month is a state, not a proof.
 */
export function BillingSection() {
  const { t, i18n } = useTranslation(BILLING_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const periods = useBillingPeriods();
  const [selected, setSelected] = React.useState<string | null>(null);
  const shown = selected ?? periods.data?.items[0]?.period ?? null;

  return (
    <div className="space-y-6">
      <p className="max-w-prose text-sm text-muted-foreground">{t("intro")}</p>
      {periods.isError ? (
        <ErrorState
          title={t("loadError")}
          error={periods.error}
          onRetry={() => void periods.refetch()}
          retrying={periods.isFetching}
        />
      ) : periods.data ? (
        <MonthsCard list={periods.data} shown={shown} onShow={setSelected} language={language} />
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
      {shown ? <MonthCard period={shown} language={language} /> : null}
    </div>
  );
}

function MonthsCard({
  list,
  shown,
  onShow,
  language,
}: {
  list: BillingPeriodList;
  shown: string | null;
  onShow: (period: string) => void;
  language: string;
}) {
  const { t } = useTranslation(BILLING_NAMESPACE);
  const date = (iso: string) => formatDateTime(iso, language) ?? iso;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("months.title")}</CardTitle>
        <CardDescription>{t("months.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table className="min-w-[40rem]" scrollLabel={t("months.caption")}>
          <TableCaption className="sr-only">{t("months.caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("months.columns.month")}</TableHead>
              <TableHead scope="col">{t("months.columns.status")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("months.columns.tenants")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("months.columns.total")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("months.columns.correctedTotal")}
              </TableHead>
              <TableHead scope="col">{t("months.columns.closedAt")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow data-period={list.open.period}>
              <TableCell className="font-medium">
                {formatPeriod(list.open.period, language)}
              </TableCell>
              <TableCell>
                <Badge variant="info">{t("months.open")}</Badge>
              </TableCell>
              <TableCell className="text-right text-muted-foreground">–</TableCell>
              <TableCell className="text-right text-muted-foreground">–</TableCell>
              <TableCell className="text-right text-muted-foreground">–</TableCell>
              <TableCell className="text-muted-foreground">
                {t("months.closesAt", { date: date(list.open.closesAt) })}
              </TableCell>
            </TableRow>
            {list.items.map((item) => {
              const month = formatPeriod(item.period, language);
              const current = item.period === shown;
              return (
                <TableRow
                  key={item.period}
                  data-period={item.period}
                  data-state={current ? "selected" : undefined}
                >
                  <TableCell>
                    <Button
                      variant="link"
                      className="h-auto p-0 font-medium"
                      aria-pressed={current}
                      aria-label={
                        current ? t("months.shown", { month }) : t("months.show", { month })
                      }
                      onClick={() => onShow(item.period)}
                    >
                      {month}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t("months.closed")}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{item.tenants}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.total === null ? "–" : formatMoney(item.total, item.currency, language)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.correctedTotal === null
                      ? "–"
                      : formatMoney(item.correctedTotal, item.currency, language)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{date(item.closedAt)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {list.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("months.empty")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function tenantNote(tenant: BillingPeriodTenant, t: (key: string) => string): string | null {
  if (tenant.kind === "internal") return t("month.internal");
  if (tenant.status === "deleting") return t("month.deleting");
  return null;
}

function MonthCard({ period, language }: { period: string; language: string }) {
  const { t } = useTranslation(BILLING_NAMESPACE);
  const { t: tCommon } = useTranslation();
  const query = useBillingPeriod(period);
  const access = useInstallationAccess();
  const [adding, setAdding] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const month = formatPeriod(period, language);

  if (query.isError) {
    return (
      <ErrorState
        title={t("month.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const data = query.data;
  if (!data) {
    return <Skeleton className="h-64 w-full" />;
  }
  const money = (value: number) => formatMoney(value, data.currency, language);

  async function exportCsv() {
    setExporting(true);
    const toastId = toast.loading(t("csv.preparing"));
    try {
      const filename = await downloadFile({
        path: billingCsvPath(period),
        accept: "text/csv",
        fallbackName: `billing-${period}.csv`,
      });
      toast.success(t("csv.done"), { id: toastId, description: filename });
    } catch (error) {
      toast.error(t("csv.failed"), { id: toastId, description: tCommon(errorMessageKey(error)) });
    } finally {
      setExporting(false);
    }
  }

  const corrections = data.tenants.flatMap((tenant) =>
    tenant.corrections.map((correction) => ({ tenant, correction })),
  );

  return (
    <Card data-month={period}>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle>{month}</CardTitle>
          <CardDescription>
            {t("month.closedAt", {
              date: formatDateTime(data.closedAt, language) ?? data.closedAt,
              zone: data.timeZone,
            })}
            {" · "}
            {t("month.sampled", { sampled: data.sampledDays, days: data.days })}
          </CardDescription>
        </div>
        <Button variant="outline" onClick={() => void exportCsv()} loading={exporting}>
          <Download aria-hidden="true" />
          {t("csv.export")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {hasGaps(data) ? (
          <Alert variant="info">
            <AlertDescription>{t("month.gaps")}</AlertDescription>
          </Alert>
        ) : null}
        {data.tenants.length === 0 ? (
          <EmptyState icon={Receipt} title={t("month.empty")} />
        ) : (
          <LinesTable data={data} month={month} language={language} money={money} />
        )}

        <section className="space-y-3" aria-labelledby={`corrections-${period}`}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h3 id={`corrections-${period}`} className="font-medium">
              {t("corrections.title")}
            </h3>
            <Button
              variant="outline"
              size="sm"
              disabled={access.change !== null || data.tenants.length === 0}
              onClick={() => setAdding(true)}
            >
              <Plus aria-hidden="true" />
              {t("corrections.add")}
            </Button>
          </div>
          <AccessNote block={access.change} level="owner" />
          {corrections.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("corrections.empty")}</p>
          ) : (
            <Table className="min-w-[40rem]" scrollLabel={t("corrections.caption", { month })}>
              <TableCaption className="sr-only">{t("corrections.caption", { month })}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("corrections.columns.tenant")}</TableHead>
                  <TableHead scope="col">{t("corrections.columns.line")}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("corrections.columns.amount")}
                  </TableHead>
                  <TableHead scope="col">{t("corrections.columns.reason")}</TableHead>
                  <TableHead scope="col">{t("corrections.columns.by")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {corrections.map(({ tenant, correction }) => (
                  <TableRow key={correction.id}>
                    <TableCell>{tenant.name}</TableCell>
                    <TableCell>
                      {correction.type ? t(lineKey(correction.type)) : t("corrections.whole")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(correction.amount)}
                    </TableCell>
                    <TableCell className="max-w-72 whitespace-pre-wrap break-words">
                      {correction.reason}
                    </TableCell>
                    <TableCell>
                      {t("corrections.by", {
                        who: correction.createdBy,
                        date:
                          formatDateTime(correction.createdAt, language) ?? correction.createdAt,
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </CardContent>
      {adding ? <CorrectionDialog period={data} onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

function LinesTable({
  data,
  month,
  language,
  money,
}: {
  data: BillingPeriod;
  month: string;
  language: string;
  money: (value: number) => string;
}) {
  const { t } = useTranslation(BILLING_NAMESPACE);
  return (
    <Table className="min-w-[48rem]" scrollLabel={t("month.caption", { month })}>
      <TableCaption className="sr-only">{t("month.caption", { month })}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("month.columns.tenant")}</TableHead>
          <TableHead scope="col">{t("month.columns.line")}</TableHead>
          <TableHead scope="col" className="text-right">
            {t("month.columns.quantity")}
          </TableHead>
          <TableHead scope="col" className="text-right">
            {t("month.columns.unitPrice")}
          </TableHead>
          <TableHead scope="col">{t("month.columns.peakDate")}</TableHead>
          <TableHead scope="col" className="text-right">
            {t("month.columns.amount")}
          </TableHead>
        </TableRow>
      </TableHeader>
      {data.tenants.map((tenant) => {
        const note = tenantNote(tenant, t);
        const rows = Math.max(1, tenant.lines.length);
        const head = (
          <TableHead scope="rowgroup" rowSpan={rows} className="align-top font-normal">
            <span className="font-medium text-foreground">{tenant.name}</span>
            <span className="block text-xs text-muted-foreground">
              {tenant.customerNumber ?? t("month.noCustomerNumber")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t("month.sampledDays", { count: tenant.sampledDays })}
            </span>
            {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
            {!tenant.complete ? (
              <Badge variant="warning" className="mt-1">
                {t("month.incomplete")}
              </Badge>
            ) : null}
          </TableHead>
        );
        return (
          <TableBody key={tenant.tenantId} data-tenant={tenant.tenantId}>
            {tenant.lines.length === 0 ? (
              <TableRow>
                {head}
                <TableCell colSpan={5} className="text-muted-foreground">
                  {t("month.noPrice")}
                </TableCell>
              </TableRow>
            ) : (
              tenant.lines.map((line, index) => (
                <TableRow key={line.type}>
                  {index === 0 ? head : null}
                  <TableCell>
                    {t(lineKey(line.type))}
                    <span className="block text-xs text-muted-foreground">
                      {t(`priceSource.${line.priceSource}`)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQuantity(line.quantity, language)}{" "}
                    <span className="text-muted-foreground">
                      {t(unitKey(line.unit), { unit: line.unit })}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(line.unitPrice)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDay(line.peakDate, language)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(line.amount)}</TableCell>
                </TableRow>
              ))
            )}
            {tenant.total !== null ? (
              <TableRow className="text-muted-foreground">
                <TableCell colSpan={5} className="text-right">
                  {t("month.tenantTotal", { name: tenant.name })}
                  {tenant.correctedTotal !== tenant.total && tenant.correctedTotal !== null
                    ? ` (${t("month.correctedTotal")}: ${money(tenant.correctedTotal)})`
                    : ""}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums text-foreground">
                  {money(tenant.total)}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        );
      })}
      <TableFooter>
        <TableRow>
          <TableCell colSpan={5} className="text-right font-medium">
            {t("month.total")}
          </TableCell>
          <TableCell className="text-right font-medium tabular-nums">
            {data.total === null ? "–" : money(data.total)}
          </TableCell>
        </TableRow>
        {data.correctedTotal !== data.total ? (
          <TableRow>
            <TableCell colSpan={5} className="text-right">
              {t("month.correctedTotal")}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {data.correctedTotal === null ? "–" : money(data.correctedTotal)}
            </TableCell>
          </TableRow>
        ) : null}
      </TableFooter>
    </Table>
  );
}

function CorrectionDialog({ period, onClose }: { period: BillingPeriod; onClose: () => void }) {
  const { t } = useTranslation(BILLING_NAMESPACE);
  const create = useCreateCorrection(period.period);
  const [tenantId, setTenantId] = React.useState(period.tenants[0]?.tenantId ?? "");
  const [line, setLine] = React.useState<BillingLineType | "">("");
  const [amountText, setAmountText] = React.useState("");
  const [reason, setReason] = React.useState("");
  const amount = parseAmount(amountText);
  const amountInvalid = amountText.trim().length > 0 && amount === null;
  const ready = tenantId !== "" && amount !== null && reason.trim().length >= 3;

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("corrections.dialog.title")}
      description={t("corrections.dialog.description")}
      confirmLabel={t("corrections.dialog.confirm")}
      confirmDisabled={!ready}
      onConfirm={async () => {
        if (amount === null) return;
        await create.mutateAsync({
          tenantId,
          ...(line ? { type: line } : {}),
          amount,
          reason: reason.trim(),
        });
        toast.success(t("corrections.done"));
        onClose();
      }}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="correction-tenant">{t("corrections.dialog.tenant")}</Label>
          <NativeSelect
            id="correction-tenant"
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
          >
            {period.tenants.map((tenant) => (
              <option key={tenant.tenantId} value={tenant.tenantId}>
                {tenant.customerNumber ? `${tenant.name} (${tenant.customerNumber})` : tenant.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="correction-line">{t("corrections.dialog.line")}</Label>
          <NativeSelect
            id="correction-line"
            value={line}
            onChange={(event) => setLine(event.target.value as BillingLineType | "")}
          >
            <option value="">{t("corrections.whole")}</option>
            {LINE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(lineKey(type))}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="correction-amount">
            {t("corrections.dialog.amount", { currency: period.currency })}
          </Label>
          <Input
            id="correction-amount"
            inputMode="decimal"
            value={amountText}
            aria-invalid={amountInvalid}
            aria-describedby="correction-amount-hint"
            onChange={(event) => setAmountText(event.target.value)}
          />
          <p id="correction-amount-hint" className="text-xs text-muted-foreground">
            {amountInvalid
              ? t("corrections.dialog.amountInvalid")
              : t("corrections.dialog.amountHint")}
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="correction-reason">{t("corrections.dialog.reason")}</Label>
          <Textarea
            id="correction-reason"
            value={reason}
            placeholder={t("corrections.dialog.reasonPlaceholder")}
            aria-describedby="correction-reason-hint"
            onChange={(event) => setReason(event.target.value)}
          />
          <p id="correction-reason-hint" className="text-xs text-muted-foreground">
            {t("corrections.dialog.reasonHint")}
          </p>
        </div>
      </div>
    </ConfirmDialog>
  );
}
