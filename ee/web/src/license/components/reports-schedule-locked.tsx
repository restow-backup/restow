import { Link, type LinkProps } from "@tanstack/react-router";
import { KeyRound, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { installationSectionPath } from "@/features/installation/paths";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import { LICENSE_SECTION_ID } from "../nav-lock";

/**
 * Why no scheduled report can be added (slot `reports.scheduleLocked`, the rules of a tenant's
 * Notifications): reports on a schedule belong to Business. A provider administrator gets the way
 * to the license page; everyone else is told who can unlock it, never a link to a page they may
 * not open.
 */
export function ReportsScheduleLocked() {
  const { t } = useTranslation("license");
  const { isProviderAdmin } = useSession();
  return (
    <span className="flex flex-wrap items-center gap-2" data-slot="reports-locked">
      <StatusBadge tone="muted" icon={Lock}>
        {t("reports.locked")}
      </StatusBadge>
      {isProviderAdmin ? (
        <Link
          to={installationSectionPath(LICENSE_SECTION_ID) as LinkProps["to"]}
          search={{ requires: "business" } as never}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
        >
          <KeyRound />
          {t("reports.action")}
        </Link>
      ) : (
        <span className="text-xs text-muted-foreground">{t("reports.askProvider")}</span>
      )}
    </span>
  );
}
