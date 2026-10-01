import { Building, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** No tenant is active, so there is nothing to scope sources to. */
export function NoTenantSelected() {
  const { t } = useTranslation("sources");
  return (
    <Alert variant="info">
      <Building />
      <AlertTitle>{t("noTenant.title")}</AlertTitle>
      <AlertDescription>{t("noTenant.description")}</AlertDescription>
    </Alert>
  );
}

/** Managing sources needs the tenant admin role in the active tenant. */
export function SourcesForbidden() {
  const { t: tc } = useTranslation();
  return (
    <Alert variant="warning">
      <ShieldAlert />
      <AlertTitle>{tc("errors.title")}</AlertTitle>
      <AlertDescription>{tc("errors.forbidden")}</AlertDescription>
    </Alert>
  );
}
