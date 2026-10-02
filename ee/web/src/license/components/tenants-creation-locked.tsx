import { Link, type LinkProps } from "@tanstack/react-router";
import { KeyRound, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { installationSectionPath } from "@/features/installation/paths";
import { cn } from "@/lib/utils";

import { useEdition } from "../edition";
import { LICENSE_SECTION_ID } from "../nav-lock";

/**
 * Why no further tenant can be created (slot `tenants.creationLocked`): the
 * edition in effect manages one tenant, and where a Service Provider key is
 * entered.
 */
export function TenantsCreationLocked() {
  const { t } = useTranslation("license");
  const edition = useEdition() ?? "community";
  return (
    <Alert variant="info">
      <Lock />
      <AlertTitle>{t("tenants.blocked.title")}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{t("tenants.blocked.description", { edition })}</span>
        <Link
          to={installationSectionPath(LICENSE_SECTION_ID) as LinkProps["to"]}
          search={{ requires: "service_provider" } as never}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
        >
          <KeyRound />
          {t("tenants.blocked.action")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
