import { Link } from "@tanstack/react-router";
import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { PVE_ROLES, pveTo } from "@/features/pve/paths";
import { canAccess, useSession } from "@/lib/session";

/**
 * "Proxmox VE", next to the buttons that add an agent: VMs and containers are
 * backed up through the Proxmox VE page (VMs & containers), not through an
 * agent, so the inventory points there. Only for the roles that may open it.
 */
export function ProxmoxLink() {
  const { t } = useTranslation("endpoints");
  const { role } = useSession();
  if (!canAccess(role, PVE_ROLES)) {
    return null;
  }
  return (
    <Button asChild size="sm" variant="outline" data-slot="proxmox-link">
      <Link {...pveTo()}>
        <Server aria-hidden="true" />
        {t("proxmox.label")}
      </Link>
    </Button>
  );
}
