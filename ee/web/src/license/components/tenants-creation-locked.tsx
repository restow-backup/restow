import { Link, type LinkProps } from "@tanstack/react-router";
import { KeyRound, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { SETTINGS_PATH } from "@/features/settings/paths";
import { cn } from "@/lib/utils";

import { useEdition } from "../edition";

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
          to={SETTINGS_PATH as LinkProps["to"]}
          search={{ section: "about", requires: "service_provider" } as never}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
        >
          <KeyRound />
          {t("tenants.blocked.action")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
