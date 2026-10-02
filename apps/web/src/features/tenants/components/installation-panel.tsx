import { Building2, Info, Mail } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ExtensionSlot } from "@/lib/extensions";

import { installationUsage } from "../presenters";
import type { UsageOverview } from "../types";

interface InstallationPanelProps {
  tenantCount: number;
  /** Whether another tenant may be created (presenters.ts `canCreateTenant`). */
  creationAllowed: boolean;
  usage: { status: "pending" | "error" | "success"; data: UsageOverview | undefined };
}

/**
 * The installation at a glance, above the tenant list: protected mailboxes
 * and the number of tenants. When no further tenant may be created, the
 * reason is stated here (not only as a disabled button); an extension may
 * word it through the `tenants.creationLocked` slot, the core says it
 * neutrally.
 */
export function InstallationPanel({ tenantCount, creationAllowed, usage }: InstallationPanelProps) {
  const { t } = useTranslation("tenants");

  return (
    <div className="space-y-4">
      <Card className="grid gap-4 p-4 sm:grid-cols-2 sm:gap-6 sm:p-5">
        <Fact icon={Mail} label={t("overview.mailboxes")}>
          {usage.status === "pending" ? (
            <div aria-busy="true" className="space-y-1.5 pt-0.5">
              <Skeleton className="h-4 w-40" />
              <span className="sr-only">{t("common:loading.label")}</span>
            </div>
          ) : usage.data ? (
            <UsageText usage={usage.data} />
          ) : (
            <span className="text-sm text-muted-foreground">{t("overview.usageUnavailable")}</span>
          )}
        </Fact>
        <Fact icon={Building2} label={t("overview.tenantsLabel")}>
          <span className="font-medium tabular-nums">
            {t("overview.tenants", { count: tenantCount })}
          </span>
        </Fact>
      </Card>

      {creationAllowed ? null : (
        <ExtensionSlot
          name="tenants.creationLocked"
          props={{}}
          fallback={
            <Alert variant="info">
              <Info />
              <AlertTitle>{t("overview.single")}</AlertTitle>
            </Alert>
          }
        />
      )}
    </div>
  );
}

function UsageText({ usage }: { usage: UsageOverview }) {
  const { t } = useTranslation("tenants");
  const message = installationUsage(usage);
  return <span className="font-medium tabular-nums">{t(message.key, message.values)}</span>;
}

interface FactProps {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  children: React.ReactNode;
}

function Fact({ icon: Icon, label, children }: FactProps) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden={true} />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {children}
      </div>
    </div>
  );
}
