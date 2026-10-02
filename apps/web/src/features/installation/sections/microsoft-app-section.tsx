import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { MicrosoftAppSetup } from "@/features/settings/microsoft-app/microsoft-app-setup";

import { AccessNote, useInstallationAccess } from "../access";
import { useWordingScope } from "../scope";

/**
 * Installation, Microsoft multi-tenant app: the optional app registration of
 * this installation (the guide of features/settings/microsoft-app). One
 * sentence says when it is needed at all; the guide below it enters and tests
 * the registration, and reads the same for provider roles that may not change
 * it. The per-tenant app and the tenants using this one come with the tenant
 * page.
 */
export function MicrosoftAppSection() {
  const { t } = useTranslation("installation");
  const scope = useWordingScope();
  const access = useInstallationAccess();
  return (
    <div className="space-y-6">
      <Alert variant="info">
        <Info />
        <AlertDescription>{t("microsoftApp.optional", { scope })}</AlertDescription>
      </Alert>
      <AccessNote block={access.change} level="owner" />
      <MicrosoftAppSetup
        variant="page"
        closed={{ change: access.change !== null, test: access.operate !== null }}
      />
    </div>
  );
}
