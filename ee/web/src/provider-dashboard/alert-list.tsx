import { BellRing, CircleCheck } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, RelativeTime, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { ProviderAlert } from "@/features/dashboard/api";
import "@/features/dashboard/i18n";

/** Alerts shown before "Show all". */
export const ALERTS_COLLAPSED = 6;

interface AlertListProps {
  alerts: ProviderAlert[];
  onOpenTenant: (tenantId: string) => void;
}

function AlertRow({
  alert,
  onOpenTenant,
}: { alert: ProviderAlert; onOpenTenant: (id: string) => void }) {
  const { t } = useTranslation("dashboard");
  return (
    <li
      data-alert={alert.kind}
      className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={alert.severity} icon>
            {t(`provider.alerts.severity.${alert.severity}`)}
          </StatusBadge>
          <span className="text-sm font-medium">{alert.tenantName}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t(`provider.alerts.kinds.${alert.kind}`, { count: alert.count ?? 0 })}
          {alert.since ? (
            <>
              {" "}
              <RelativeTime value={alert.since} />
            </>
          ) : null}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 self-start"
        onClick={() => onOpenTenant(alert.tenantId)}
      >
        {t("provider.alerts.open")}
      </Button>
    </li>
  );
}

/** What needs attention across all tenants, most severe first. */
export function AlertList({ alerts, onOpenTenant }: AlertListProps) {
  const { t } = useTranslation("dashboard");
  const [expanded, setExpanded] = React.useState(false);
  const shown = expanded ? alerts : alerts.slice(0, ALERTS_COLLAPSED);
  const hidden = alerts.length - shown.length;

  return (
    <Card
      data-widget="providerAlerts"
      data-state={alerts.length === 0 ? "empty" : "ready"}
      className="gap-4"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("provider.alerts.title")}
          {alerts.length > 0 ? (
            <StatusBadge
              tone={
                alerts.some((alert) => alert.severity === "destructive") ? "destructive" : "warning"
              }
            >
              {alerts.length}
            </StatusBadge>
          ) : null}
        </CardTitle>
        <CardDescription>{t("provider.alerts.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <EmptyState
            icon={CircleCheck}
            title={t("provider.alerts.empty.title")}
            description={t("provider.alerts.empty.description")}
            variant="plain"
            className="py-6"
          />
        ) : (
          <div className="space-y-3">
            <ul className="divide-y">
              {shown.map((alert) => (
                <AlertRow
                  key={`${alert.tenantId}:${alert.kind}`}
                  alert={alert}
                  onOpenTenant={onOpenTenant}
                />
              ))}
            </ul>
            {hidden > 0 || expanded ? (
              <Button variant="ghost" size="sm" onClick={() => setExpanded((open) => !open)}>
                {expanded
                  ? t("provider.alerts.showFewer")
                  : t("provider.alerts.showAll", { count: alerts.length })}
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
