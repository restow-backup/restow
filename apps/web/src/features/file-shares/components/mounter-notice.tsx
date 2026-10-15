import { PlugZap } from "lucide-react";

import { CopyButton } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EnableMounterButton } from "@/features/installation/sections/enable-mounter";
import { useMounts } from "@/features/installation/sections/mounts-api";
import { useSession } from "@/lib/session";

import type { TenantShareSettings } from "../api.js";
import { useShareFormat } from "../hooks.js";

/**
 * File share backup needs the mounter (docs/FILESHARES.md 3.9, 12.2). While it is not running,
 * provider owners see **Enable network shares** when the opt-in updater can start it, and the
 * one command that starts it in any case; other provider admins see that an owner can start
 * it, and tenant admins that the installation does not offer file share backup yet.
 */
export function MounterNotice({ settings }: { settings: TenantShareSettings }) {
  const { t } = useShareFormat();
  const { isProviderAdmin, providerRole, providerAllTenants } = useSession();
  const runner = settings.runner;
  const off = !(runner.available && runner.ready);
  const owner =
    isProviderAdmin && (providerRole ?? "owner") === "owner" && providerAllTenants !== false;
  const mounts = useMounts(off && owner);
  if (!off) {
    return null;
  }
  const blocked = runner.available && !runner.ready;
  const viaUpdater = !blocked && mounts.data?.enable?.via === "updater";
  return (
    <Alert variant="warning" data-slot="mounter-notice">
      <PlugZap aria-hidden="true" />
      <AlertTitle>{t(blocked ? "mounter.blockedTitle" : "mounter.offTitle")}</AlertTitle>
      <AlertDescription className="space-y-2">
        {!isProviderAdmin ? (
          <p>{t("mounter.tenant")}</p>
        ) : owner ? (
          <>
            <p>
              {t(
                blocked
                  ? "mounter.blockedOwner"
                  : viaUpdater
                    ? "mounter.owner"
                    : "mounter.ownerCommand",
              )}
            </p>
            {viaUpdater ? <EnableMounterButton view={mounts.data} mayEnable /> : null}
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
