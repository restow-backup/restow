import { Link, type LinkProps } from "@tanstack/react-router";
import { KeyRound, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { installationSectionPath } from "@/features/installation/paths";
import type { SlotProps } from "@/lib/extensions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import { requiredEditionOf } from "../edition";
import { LICENSE_SECTION_ID } from "../nav-lock";

/**
 * Why a part of a page is closed (slot `feature.locked`, 0.5.0): the edition that unlocks the
 * gated feature. A provider administrator gets the way to the license page, which names that
 * edition; everyone else is told who can unlock it, never a link to a page they may not open.
 */
export function FeatureLocked({ feature }: SlotProps["feature.locked"]) {
  const { t } = useTranslation("license");
  const { isProviderAdmin } = useSession();
  const edition = requiredEditionOf(feature) ?? "business";
  return (
    <span
      className="flex flex-wrap items-center gap-2"
      data-slot="feature-locked"
      data-feature={feature}
      data-edition={edition}
    >
      <StatusBadge tone="muted" icon={Lock}>
        {t(`locked.${edition}`)}
      </StatusBadge>
      {isProviderAdmin ? (
        <Link
          to={installationSectionPath(LICENSE_SECTION_ID) as LinkProps["to"]}
          search={{ requires: feature } as never}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
        >
          <KeyRound />
          {t("reports.action")}
        </Link>
      ) : (
        <span className="text-xs text-muted-foreground">{t("feature.askProvider")}</span>
      )}
    </span>
  );
}
