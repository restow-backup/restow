import { Building2, ShieldAlert } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useSession } from "@/lib/session";

import { MembersPanel } from "./components/members-panel";

/**
 * Members of the active tenant, for the tenant's own admins: who may sign
 * in, with which role, and open invitations. Provider admins reach the same
 * panel through the tenant pages.
 */
export function MembersPage() {
  const { t } = useTranslation("tenants");
  const { activeTenant, isProviderAdmin } = useSession();
  const canManage = isProviderAdmin || activeTenant?.role === "tenant_admin";

  let body: React.ReactNode;
  if (!activeTenant) {
    body = (
      <Alert variant="info">
        <Building2 />
        <AlertTitle>{t("membersPage.noTenant.title")}</AlertTitle>
        <AlertDescription>{t("membersPage.noTenant.description")}</AlertDescription>
      </Alert>
    );
  } else if (!canManage) {
    body = (
      <Alert variant="warning">
        <ShieldAlert />
        <AlertTitle>{t("membersPage.forbidden.title")}</AlertTitle>
        <AlertDescription>{t("membersPage.forbidden.description")}</AlertDescription>
      </Alert>
    );
  } else {
    // Keyed by tenant so switching tenants never shows the previous list.
    body = (
      <MembersPanel
        key={activeTenant.id}
        tenantId={activeTenant.id}
        tenantName={activeTenant.name}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("membersPage.title")}
        description={
          activeTenant
            ? t("membersPage.subtitle", { tenant: activeTenant.name })
            : t("membersPage.subtitleNoTenant")
        }
      />
      {body}
    </div>
  );
}
