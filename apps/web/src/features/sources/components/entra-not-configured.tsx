import { Link } from "@tanstack/react-router";
import { Globe, KeyRound, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { installationSectionTo } from "@/features/installation/paths";
import { MicrosoftAppSetup } from "@/features/settings/microsoft-app/microsoft-app-setup";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { EntraAppStatus } from "../types";

/**
 * The installation cannot connect tenants yet. A provider admin gets the
 * guided setup of the app registration right here (or, when only the public
 * URL is missing, the way to set it); a tenant admin learns that the service
 * provider has to act first.
 */
export function EntraNotConfigured({ status }: { status: EntraAppStatus }) {
  const { t } = useTranslation("sources");
  const { isProviderAdmin } = useSession();

  if (!isProviderAdmin) {
    return (
      <Alert variant="warning">
        <KeyRound />
        <AlertTitle>{t("m365.entra.tenantAdmin.title")}</AlertTitle>
        <AlertDescription>{t("m365.entra.tenantAdmin.description")}</AlertDescription>
      </Alert>
    );
  }

  if (status.reasons.some((reason) => reason !== "no_public_url")) {
    return <MicrosoftAppSetup variant="inline" />;
  }

  return (
    <Alert variant="warning">
      <Globe />
      <AlertTitle>{t("m365.entra.provider.title")}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t("m365.entra.provider.description")}</p>
        <Link
          to={installationSectionTo("microsoft-app")}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
        >
          <Settings aria-hidden="true" />
          {t("m365.entra.provider.openSettings")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
