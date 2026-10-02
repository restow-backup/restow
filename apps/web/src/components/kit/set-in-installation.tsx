import { Link, type LinkProps } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { useSession } from "@/lib/session";

import { UI_NAMESPACE } from "./i18n.js";

/**
 * The note under a value that a tenant page shows but the installation owns
 * (the public address, the default storage, the journal host): the value is
 * read-only here, and "Set in the installation" says where it is set. Only a
 * provider admin gets the link into the installation page; a tenant's own
 * administrator is told whom to ask instead of being sent to a page they
 * cannot open (clarity rule 3).
 */
export function SetInInstallation({
  to,
  sectionLabel,
  className,
}: {
  /** Absolute path of the installation section that holds the value. */
  to: string;
  /** Translated name of that section ("Server"), for the link text. */
  sectionLabel: string;
  className?: string;
}): React.ReactNode {
  const { t } = useTranslation(UI_NAMESPACE);
  const { isProviderAdmin } = useSession();
  return (
    <span
      data-slot="set-in-installation"
      className={className ?? "flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"}
    >
      <Lock aria-hidden="true" className="size-3 shrink-0" />
      {t("installationValue.label")}
      {isProviderAdmin ? (
        <Link
          to={to as LinkProps["to"]}
          className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
        >
          {t("installationValue.open", { section: sectionLabel })}
        </Link>
      ) : (
        <span>{t("installationValue.ask")}</span>
      )}
    </span>
  );
}
