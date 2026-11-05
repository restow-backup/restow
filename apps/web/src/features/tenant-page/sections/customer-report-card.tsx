import { Link } from "@tanstack/react-router";
import { FileText, Send } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { NativeSelect } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { FeatureLocked } from "@/features/installation/feature-locked";
import {
  type CustomerReportPatch,
  customerReportPdfPath,
  useCustomerReport,
  useTestCustomerReport,
  useUpdateCustomerReport,
} from "@/features/reports/customer-report-api";
import { downloadFile } from "@/features/stats/download";
import { errorMessageKey } from "@/lib/api";
import { tenantPageTo } from "@/lib/tenant-paths";

const HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour);
const DAYS: readonly number[] = Array.from({ length: 28 }, (_, index) => index + 1);

/**
 * The customer monthly report of a tenant (0.5.0, Service Provider; provider administrators
 * only): once a month, on the chosen day and hour, an HTML mail with the PDF to the contacts who
 * receive it (Master data), with the provider's or the tenant's branding. Below Business it says
 * which edition adds it.
 */
export function CustomerReportCard({
  tenantId,
  readOnly = false,
}: {
  tenantId: string;
  /** The tenant page is closed for changes (the demo, a looking role): show, do not change. */
  readOnly?: boolean;
}) {
  const { t, i18n } = useTranslation("tenantpage");
  const { t: tc } = useTranslation();
  const query = useCustomerReport(tenantId);
  const update = useUpdateCustomerReport(tenantId);
  const test = useTestCustomerReport(tenantId);
  const [previewing, setPreviewing] = React.useState(false);
  const language = i18n.resolvedLanguage ?? i18n.language;

  const header = (
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base">
        <FileText aria-hidden="true" className="size-4 text-muted-foreground" />
        {t("customerReport.title")}
      </CardTitle>
      <CardDescription>{t("customerReport.description")}</CardDescription>
    </CardHeader>
  );

  if (query.isPending) {
    return (
      <Card data-slot="customer-report">
        {header}
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title={t("customerReport.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const settings = query.data;
  if (!settings.available) {
    return (
      <Card data-slot="customer-report" data-locked="true">
        {header}
        <CardContent>
          <FeatureLocked feature="reports.customer" />
        </CardContent>
      </Card>
    );
  }

  const change = (patch: CustomerReportPatch) =>
    update.mutate(patch, {
      onSuccess: () => toast.success(t("customerReport.saved")),
      onError: (error) => toast.error(tc(errorMessageKey(error))),
    });
  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" })
      : t("customerReport.never");

  async function preview() {
    setPreviewing(true);
    try {
      await downloadFile({
        path: customerReportPdfPath(tenantId, language),
        accept: "application/pdf",
        fallbackName: "customer-report.pdf",
      });
    } catch (error) {
      toast.error(tc(errorMessageKey(error)));
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <Card data-slot="customer-report">
      {header}
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <Switch
            id="customer-report-enabled"
            checked={settings.enabled}
            disabled={readOnly || update.isPending}
            onCheckedChange={(enabled) => change({ enabled })}
          />
          <div className="space-y-0.5">
            <Label htmlFor="customer-report-enabled">{t("customerReport.enabled")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("customerReport.runs", {
                next: when(settings.nextRunAt),
                last: when(settings.lastRunAt),
              })}
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="customer-report-day">{t("customerReport.sendDay")}</Label>
            <NativeSelect
              id="customer-report-day"
              value={String(settings.sendDay)}
              disabled={readOnly || update.isPending}
              onChange={(event) => change({ sendDay: Number(event.target.value) })}
            >
              {DAYS.map((day) => (
                <option key={day} value={day}>
                  {t("customerReport.day", { day })}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="customer-report-hour">{t("customerReport.sendHour")}</Label>
            <NativeSelect
              id="customer-report-hour"
              value={String(settings.sendHour)}
              disabled={readOnly || update.isPending}
              onChange={(event) => change({ sendHour: Number(event.target.value) })}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {`${String(hour).padStart(2, "0")}:00`}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">
              {t("customerReport.timezone", { zone: settings.timezone })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="customer-report-language">{t("customerReport.language")}</Label>
            <NativeSelect
              id="customer-report-language"
              value={settings.language ?? ""}
              disabled={readOnly || update.isPending}
              onChange={(event) => {
                const value = event.target.value;
                change({ language: value === "de" || value === "en" ? value : null });
              }}
            >
              <option value="">{t("customerReport.languageTenant")}</option>
              <option value="de">{tc("language.de")}</option>
              <option value="en">{tc("language.en")}</option>
            </NativeSelect>
          </div>
        </div>
        <div className="space-y-1" data-slot="customer-report-recipients">
          <p className="text-sm font-medium">{t("customerReport.recipients")}</p>
          {settings.recipients.length > 0 ? (
            <ul className="text-sm text-muted-foreground">
              {settings.recipients.map((recipient) => (
                <li key={recipient.contactId}>
                  {recipient.name} &lt;{recipient.email}&gt;
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("customerReport.noRecipients")}{" "}
              <Link
                to={tenantPageTo(tenantId, "master-data")}
                className="text-primary hover:underline"
              >
                {t("customerReport.openContacts")}
              </Link>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={previewing}
            onClick={() => void preview()}
          >
            {previewing ? null : <FileText aria-hidden="true" />}
            {t("customerReport.previewPdf")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={readOnly}
            loading={test.isPending}
            onClick={() =>
              test.mutate(undefined, {
                onSuccess: (result) =>
                  toast.success(t("customerReport.testSent", { to: result.to })),
                onError: (error) => toast.error(tc(errorMessageKey(error))),
              })
            }
          >
            {test.isPending ? null : <Send aria-hidden="true" />}
            {t("customerReport.test")}
          </Button>
        </div>
        {settings.lastDelivery ? (
          <p className="text-xs text-muted-foreground">
            {t("customerReport.lastDelivery", {
              at: when(settings.lastDelivery.at),
              status: t(`reports:deliveries.status.${settings.lastDelivery.status}`, {
                defaultValue: settings.lastDelivery.status,
              }),
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
