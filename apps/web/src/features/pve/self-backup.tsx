import { ServerCog } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import { type PveGuest, selfBackupBlocked } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/**
 * The Restow server's own VM (docs/PVE.md, "The Restow server's own VM"): Restow found it by its
 * SMBIOS UUID, or an admin marked it. Backing it up with Restow itself can deadlock (the backup
 * freezes or snapshots the server that receives it) and a restore of it needs the server that
 * is being restored, so "Back up now" and putting it into a job ask first.
 */

function guestName(guest: Pick<PveGuest, "name" | "kind" | "vmid">): string {
  return guest.name ?? `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`;
}

/** The warning a guest row and the job editor show for the Restow server's own VM. */
export function RestowServerNote({
  guest,
  compact = false,
}: {
  guest: Pick<PveGuest, "restowServer" | "selfBackupConfirmedAt">;
  compact?: boolean;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  if (!guest.restowServer) {
    return null;
  }
  const reason = t(`selfBackup.reason.${guest.restowServer}`);
  if (compact) {
    return (
      <p className="text-xs text-warning-text" data-slot="pve-restow-server">
        {guest.selfBackupConfirmedAt ? t("selfBackup.confirmedShort") : t("selfBackup.short")}{" "}
        <span className="text-muted-foreground">{reason}</span>
      </p>
    );
  }
  return (
    <Alert variant="warning" data-slot="pve-restow-server">
      <ServerCog aria-hidden="true" />
      <AlertTitle>{t("selfBackup.title")}</AlertTitle>
      <AlertDescription>
        <p>{reason}</p>
        <p>{t("selfBackup.risk")}</p>
        <p>{t("selfBackup.recommendation")}</p>
        {guest.selfBackupConfirmedAt ? <p>{t("selfBackup.confirmedLong")}</p> : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Ask before an action reaches the Restow server's own VM: `guard(guests, run)` runs `run(false)`
 * at once when none of `guests` needs the confirmation, else after the admin confirmed in the
 * dialog, with `run(true)` (the request then carries `confirmSelfBackup`). Render `dialog`.
 */
export function useSelfBackupGuard() {
  const { t } = useTranslation(PVE_NAMESPACE);
  const [pending, setPending] = React.useState<{
    names: string[];
    run: () => void | Promise<void>;
  } | null>(null);
  const guard = React.useCallback(
    (guests: readonly PveGuest[], run: (confirmed: boolean) => void | Promise<void>) => {
      const blocked = guests.filter(selfBackupBlocked);
      if (blocked.length === 0) {
        void run(false);
        return;
      }
      setPending({ names: blocked.map(guestName), run: () => run(true) });
    },
    [],
  );
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => (open ? undefined : setPending(null))}
      title={t("selfBackup.confirmTitle", { name: pending?.names.join(", ") ?? "" })}
      description={t("selfBackup.risk")}
      confirmLabel={t("selfBackup.confirm")}
      destructive
      onConfirm={async () => {
        const current = pending;
        setPending(null);
        await current?.run();
      }}
    >
      <p className="text-sm text-muted-foreground">{t("selfBackup.recommendation")}</p>
    </ConfirmDialog>
  );
  return { guard, dialog };
}
