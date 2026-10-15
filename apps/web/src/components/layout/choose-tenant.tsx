import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/kit";
import { TenantIdentity } from "@/components/layout/all-tenants-list";
import { useSwitchTenant } from "@/components/tenant-switcher";
import { orderTenants } from "@/components/tenant-switcher-model";
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
                  <TenantIdentity tenant={tenant} organisationMode={organisationMode} />
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
