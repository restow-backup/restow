import { Link } from "@tanstack/react-router";
import { ArrowRight, Info, TriangleAlert, Users } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useWordingScope } from "@/features/installation/scope";
import { useReportCatalog } from "@/features/reports/hooks";
import { REPORTS_PATH } from "@/features/reports/paths";
import { AlertRulesPanel } from "@/features/reports/reports-page";
import { NotificationsStep } from "@/features/tenants/components/tenant-wizard/step-notifications";
import {
  type TenantWizardValues,
  emptyTenantWizardForm,
  tenantWizardSchema,
  undefinedIfBlank,
} from "@/features/tenants/forms";
import { useReplaceTenantNotificationRecipients, useTenantDetail } from "@/features/tenants/hooks";
import { genericError } from "@/features/tenants/presenters";
import type { TenantDetail } from "@/features/tenants/types";
import type { TenantSectionProps } from "@/lib/extensions";
import { zodResolver } from "@/lib/form";
import { useSession } from "@/lib/session";

/**
 * Notifications: who is told what about this tenant. The recipients (people
 * and the categories each one wants) come first and are what sends: every
 * category is carried by a rule of the tenant, and saving the recipients brings
 * the rules' addresses up to date. Below them the rules themselves, for what
 * goes beyond the categories (other events, a webhook, a report on a schedule).
 * The list of alerts that were sent stays in the daily work (Alerts).
 */
export function NotificationsSection({ tenant }: TenantSectionProps) {
  const { t } = useTranslation("tenantpage");
  const detail = useTenantDetail(tenant.id);

  return (
    <div className="space-y-8">
      {detail.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : detail.isError || !detail.data ? (
        <ErrorState
          title={t("notifications.loadError")}
          error={detail.error}
          onRetry={() => void detail.refetch()}
          retrying={detail.isFetching}
        />
      ) : (
        // Keyed by the saved list: after a save the form starts from what the server holds.
        <RecipientsCard key={recipientsKey(detail.data)} tenant={detail.data} />
      )}
      <AlertRulesPanel />
      <Link
        to={REPORTS_PATH as never}
        className="inline-flex items-center gap-1 rounded-sm text-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("notifications.alertsLink")}
        <ArrowRight aria-hidden="true" className="size-3.5" />
      </Link>
    </div>
  );
}

function recipientsKey(tenant: TenantDetail): string {
  return tenant.notificationRecipients
    .map((recipient) => `${recipient.id}:${recipient.categories.join(",")}`)
    .join("|");
}

function RecipientsCard({ tenant }: { tenant: TenantDetail }) {
  const { t } = useTranslation("tenantpage");
  const { t: tt } = useTranslation("tenants");
  const { isProviderAdmin } = useSession();
  const scope = useWordingScope();
  const save = useReplaceTenantNotificationRecipients(tenant.id);
  const catalog = useReportCatalog();
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm<TenantWizardValues>({
    resolver: zodResolver(tenantWizardSchema),
    defaultValues: {
      ...emptyTenantWizardForm("en"),
      notificationRecipients: tenant.notificationRecipients.map((recipient) => ({
        email: recipient.email,
        name: recipient.name ?? "",
        categories: recipient.categories,
      })),
    },
  });
  const { isSubmitting, isDirty } = form.formState;
  const chosen = form.watch("notificationRecipients");
  const weeklyWithoutReports =
    catalog.data?.scheduledAvailable === false &&
    chosen.some((recipient) => recipient.categories.includes("weeklyReport"));

  async function onSave() {
    setError(null);
    if (!(await form.trigger("notificationRecipients"))) {
      return;
    }
    try {
      await save.mutateAsync(
        form.getValues("notificationRecipients").map((recipient) => ({
          email: recipient.email.trim(),
          name: undefinedIfBlank(recipient.name),
          categories: recipient.categories,
        })),
      );
      toast.success(tt("customerPanel.recipientsSaved"));
    } catch (failure) {
      const message = genericError(failure);
      setError(tt(message.key, message.values));
    }
  }

  return (
    <Card data-slot="notification-recipients">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("notifications.recipients.title")}
        </CardTitle>
        <CardDescription>{t("notifications.recipients.description", { scope })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <NotificationsStep form={form} canOpenInstallation={isProviderAdmin} />
        {weeklyWithoutReports ? (
          <Alert variant="info" data-slot="weekly-unavailable">
            <Info />
            <AlertDescription>{t("notifications.recipients.weeklyUnavailable")}</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!isDirty || isSubmitting}
            onClick={() => form.reset()}
          >
            {t("notifications.recipients.discard")}
          </Button>
          <Button
            type="button"
            loading={isSubmitting || save.isPending}
            disabled={!isDirty}
            onClick={() => void onSave()}
          >
            {t("notifications.recipients.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
