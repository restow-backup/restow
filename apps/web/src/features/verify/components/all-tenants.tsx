import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PageHeader, RefreshButton } from "@/components/kit";
import { useSwitchTenant } from "@/components/tenant-switcher";
import { widgetView } from "@/features/dashboard/presenters";
import { useDashboard } from "@/features/dashboard/use-dashboard";
import { VERIFY_ICON } from "@/features/verify/paths";
import { type ReadinessState, verifyLink } from "@/features/verify/search";
import { ExtensionSlot } from "@/lib/extensions";
import { useSession } from "@/lib/session";

import "@/features/verify/i18n";

/**
 * Recovery readiness under "All tenants": no list of objects across tenants, but
 * the tenants that have objects in the chosen state, with their counts, from the
 * provider view of the overview (the extension that builds it fills the slot).
 * Choosing a tenant switches into it and opens its own Recovery readiness in that
 * state.
 */
export function AllTenantsReadiness({
  state,
  onStateChange,
}: {
  state: ReadinessState | undefined;
  onStateChange: (state: ReadinessState | undefined) => void;
}) {
  const { t } = useTranslation("verify");
  const navigate = useNavigate();
  const { tenants } = useSession();
  const switchTenant = useSwitchTenant();
  const { query } = useDashboard("all");
  const { refetch } = query;
  const refresh = React.useCallback(() => void refetch(), [refetch]);

  const openReadiness = React.useCallback(
    async (tenantId: string, readinessState: ReadinessState | undefined) => {
      const tenant = tenants.find((candidate) => candidate.id === tenantId);
      if (!tenant) {
        return;
      }
      // The address first, so the page never sees "All tenants" and a tenant at once.
      await navigate(verifyLink(readinessState) as never);
      switchTenant(tenant);
    },
    [navigate, switchTenant, tenants],
  );

  return (
    <div className="space-y-6" data-slot="verify-all-tenants">
      <PageHeader title={t("title")} icon={VERIFY_ICON} description={t("allScope")}>
        <RefreshButton onRefresh={refresh} fetching={query.isFetching} />
      </PageHeader>
      <p className="max-w-prose text-sm text-muted-foreground">{t("allSubtitle")}</p>
      <ExtensionSlot
        name="verify.byTenant"
        props={{
          view: widgetView(query.data?.provider ?? undefined, query.isPending),
          onRetry: refresh,
          retrying: query.isFetching,
          state,
          onStateChange,
          onOpenReadiness: (tenantId, readinessState) =>
            void openReadiness(tenantId, readinessState),
        }}
      />
    </div>
  );
}
