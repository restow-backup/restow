import { Link } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useSession } from "@/lib/session";

import { useRestarts } from "./hooks";
import "./i18n";
import { restartGroups } from "./presenters";
import { updatesTabLink } from "./settings-link";

/**
 * The notice for provider administrators while a service needs a restart
 * (features/updates/restarts on the api): which services, and a link to the
 * Updates tab, which says why and offers "Restart now" and the command.
 * Nobody else sees it (the API answers provider administrators only), and it
 * disappears by itself once the services have started again.
 */
export function RestartBanner() {
  const { t } = useTranslation("updates");
  const { isProviderAdmin } = useSession();
  const query = useRestarts(isProviderAdmin);
  const groups = isProviderAdmin && query.data ? restartGroups(query.data.requests) : [];
  if (groups.length === 0) {
    return null;
  }
  const services = groups.map((group) => t(`restart.services.${group.service}`)).join(", ");
  const link = updatesTabLink();

  return (
    <div
      data-slot="restart-banner"
      className="flex flex-wrap items-start gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-foreground sm:items-center"
    >
      <RotateCw className="mt-0.5 size-4 shrink-0 text-warning-text sm:mt-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {t("restart.banner.text", { services })}
      </p>
      <Link to={link.to} search={link.search} className="font-medium underline underline-offset-2">
        {t("restart.banner.link")}
      </Link>
    </div>
  );
}
