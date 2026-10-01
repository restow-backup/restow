import { Building, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** No tenant is active, so there is nothing to import into. */
export function NoTenantSelected() {
  const { t } = useTranslation("imports");
  return (
    <Alert variant="info">
      <Building />
      <AlertTitle>{t("noTenant.title")}</AlertTitle>
      <AlertDescription>{t("noTenant.description")}</AlertDescription>
    </Alert>
  );
}

/** Importing needs the tenant admin role in the active tenant. */
export function ImportsForbidden() {
  const { t: tc } = useTranslation();
  return (
    <Alert variant="warning">
      <ShieldAlert />
      <AlertTitle>{tc("errors.forbiddenTitle")}</AlertTitle>
      <AlertDescription>{tc("errors.forbidden")}</AlertDescription>
    </Alert>
  );
}
