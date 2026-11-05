import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useSession } from "@/lib/session";

import "./i18n";
import { installationSectionTo } from "./paths";
import { useRestoreModeBanner } from "./restore-mode-api";

/** The installation section of restore mode (sections.tsx). */
export const RESTORE_MODE_SECTION = "restore-mode" as const;

/**
 * The banner on every page for provider administrators while restore mode is on (a database dump
 * was restored, docs/STORAGE.md): nothing is deleted until a provider owner ends it. Nobody else
 * sees it (the api answers provider administrators only).
 */
export function RestoreModeBanner() {
  const { t } = useTranslation("installation");
  const { isProviderAdmin } = useSession();
  const query = useRestoreModeBanner(isProviderAdmin);
  if (!isProviderAdmin || !query.data?.active) {
    return null;
  }
  return (
    <div
      data-slot="restore-mode-banner"
      role="status"
      className="flex flex-wrap items-start gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-foreground sm:items-center"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive sm:mt-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t("restoreMode.banner.text")}</p>
      <Link
        to={installationSectionTo(RESTORE_MODE_SECTION)}
        search={{} as never}
        className="font-medium underline underline-offset-2"
      >
        {t("restoreMode.banner.link")}
      </Link>
    </div>
  );
}
