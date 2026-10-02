import { Building2, ChevronRight, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/kit";
import { useSwitchTenant } from "@/components/tenant-switcher";
import { orderTenants, tenantSublineOf } from "@/components/tenant-switcher-model";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { hasFeature, useSession } from "@/lib/session";
import { canEnterTenant } from "@/lib/tenant";
import { cn } from "@/lib/utils";

/**
 * A page that only exists per tenant, opened while the session works on "All
 * tenants" (lib/scope.ts): not an error, but the one question it needs
 * answered. The tenants are listed; choosing one makes it the active tenant and
 * the page continues, here, with that tenant. The menu dims these entries and says
 * so; this is what an address typed or bookmarked shows.
 */
export function ChooseTenantPage({ title }: { title: string }) {
  const { t } = useTranslation();
  const session = useSession();
  const switchTenant = useSwitchTenant();
  const organisationMode = !hasFeature(session, "tenants.additional");
  const tenants = orderTenants(session.tenants);

  return (
    <div className="space-y-6" data-slot="choose-tenant">
      <PageHeader title={title} description={t("chooseTenant.description")} />
      <Card className="gap-0 overflow-hidden py-0">
        <ul aria-label={t("chooseTenant.list")} className="divide-y">
          {tenants.map((tenant) => {
            const enterable = canEnterTenant(tenant.status, session.isProviderAdmin);
            const subline = tenantSublineOf(tenant, organisationMode);
            const Mark = tenant.kind === "internal" ? Shield : Building2;
            return (
              <li key={tenant.id}>
                <button
                  type="button"
                  disabled={!enterable}
                  data-tenant={tenant.id}
                  onClick={() => switchTenant(tenant)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors",
                    "hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
                    "disabled:pointer-events-none disabled:opacity-50",
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:size-4">
                    <Mark aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{tenant.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {subline.kind === "number" ? (
                        <>
                          <span className="sr-only">{`${t("tenant.customerNumber")} `}</span>
                          <span className="font-mono">{subline.number}</span>
                        </>
                      ) : subline.kind === "internal" ? (
                        t("tenant.internal")
                      ) : subline.kind === "organisation" ? (
                        t("tenant.organisation")
                      ) : (
                        t("tenant.label")
                      )}
                    </span>
                  </span>
                  {tenant.kind === "internal" && !organisationMode ? (
                    <Badge variant="info">{t("tenant.internal")}</Badge>
                  ) : null}
                  {tenant.status === "active" ? null : (
                    <Badge variant="warning">{t(`tenant.status.${tenant.status}`)}</Badge>
                  )}
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
