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
 * Why a member cannot be limited to chosen tenants (slot
 * `team.tenantScopeLocked`, the member dialog of the core's Members page):
 * in the edition in effect every member has every tenant, and where a
 * Service Provider key is entered.
 */
export function TeamScopeLocked() {
  const { t } = useTranslation("license");
  const edition = useEdition() ?? "community";
  return (
    <Alert variant="info">
      <Lock />
      <AlertTitle>{t("teamScope.title")}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{t("teamScope.description", { edition })}</span>
        <Link
          to={installationSectionPath(LICENSE_SECTION_ID) as LinkProps["to"]}
          search={{ requires: "service_provider" } as never}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
        >
          <KeyRound />
          {t("teamScope.action")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
