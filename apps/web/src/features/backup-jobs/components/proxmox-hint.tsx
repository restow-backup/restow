import { Link } from "@tanstack/react-router";
import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { inventoryTo } from "@/features/endpoints/paths";
import { PVE_ROLES, pveTo } from "@/features/pve/paths";
import { canAccess, useSession } from "@/lib/session";

/**
 * Next to the machine selection of a machine job (#53): the list holds
 * machines with the Restow agent only. Proxmox VE guests are backed up by
 * Proxmox VE jobs, a model of their own, so this points to VMs & containers
 * and to the Proxmox section of the inventory (its "Add to job" and "New
 * job"). Only for the roles that may open those pages.
 */
export function ProxmoxGuestsHint() {
  const { t } = useTranslation("backupjobs");
  const { role } = useSession();
  if (!canAccess(role, PVE_ROLES)) {
    return null;
  }
  const link = buttonVariants({ variant: "outline", size: "sm" });
  return (
    <Alert variant="info" data-slot="proxmox-hint">
      <Server aria-hidden="true" />
      <AlertTitle>{t("editor.scope.proxmox.title")}</AlertTitle>
      <AlertDescription>
        <p>{t("editor.scope.proxmox.body")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link {...pveTo()} className={link}>
            {t("editor.scope.proxmox.openGuests")}
          </Link>
          <Link to={inventoryTo()} hash="pve-inventory-title" className={link}>
            {t("editor.scope.proxmox.openInventory")}
          </Link>
        </div>
      </AlertDescription>
    </Alert>
  );
}
