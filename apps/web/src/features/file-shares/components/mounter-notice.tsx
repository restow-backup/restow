import { PlugZap } from "lucide-react";

import { CopyButton } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useSession } from "@/lib/session";

import type { TenantShareSettings } from "../api.js";
import { useShareFormat } from "../hooks.js";

/**
 * File share backup needs the mounter (docs/FILESHARES.md 3.9, 12.2). While it is not running,
 * provider owners see the one command that starts it (the button that does it through the
 * opt-in updater comes with its route), other provider admins that an owner can start it, and
 * tenant admins that the installation does not offer file share backup yet.
 */
export function MounterNotice({ settings }: { settings: TenantShareSettings }) {
  const { t } = useShareFormat();
  const { isProviderAdmin, providerRole } = useSession();
  const runner = settings.runner;
  if (runner.available && runner.ready) {
    return null;
  }
  const owner = isProviderAdmin && (providerRole ?? "owner") === "owner";
  const blocked = runner.available && !runner.ready;
  return (
    <Alert variant="warning" data-slot="mounter-notice">
      <PlugZap aria-hidden="true" />
      <AlertTitle>{t(blocked ? "mounter.blockedTitle" : "mounter.offTitle")}</AlertTitle>
      <AlertDescription className="space-y-2">
        {!isProviderAdmin ? (
          <p>{t("mounter.tenant")}</p>
        ) : owner ? (
          <>
            <p>{t(blocked ? "mounter.blockedOwner" : "mounter.owner")}</p>
            {blocked && runner.blockers.length > 0 ? (
              <ul className="list-disc pl-5 text-xs">
                {runner.blockers.map((blocker) => (
                  <li key={blocker.code}>
                    <code>{blocker.code}</code>: {blocker.detail}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-center gap-2" data-slot="mounter-command">
              <code className="rounded bg-muted px-2 py-1 font-mono text-xs">
                {settings.enableCommand}
              </code>
              <CopyButton value={settings.enableCommand} label={t("mounter.copy")} />
            </div>
            <p className="text-xs text-muted-foreground">{t("mounter.commandHint")}</p>
          </>
        ) : (
          <p>{t("mounter.provider")}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
