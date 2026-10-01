import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/ui/sonner";
import { useSession } from "@/lib/session";

import { homeTo } from "./paths";
import type { TenantItem } from "./types";

/**
 * "Switch to tenant": make the tenant the active one (every tenant-scoped
 * request then carries its id) and open its overview. The session provider
 * re-reads all tenant-scoped data on the switch.
 */
export function useEnterTenant() {
  const { t } = useTranslation("tenants");
  const { activeTenant, setActiveTenant } = useSession();
  const navigate = useNavigate();

  const enter = React.useCallback(
    (tenant: Pick<TenantItem, "id" | "name">) => {
      if (activeTenant?.id !== tenant.id) {
        setActiveTenant(tenant.id);
      }
      toast.success(t("toasts.entered", { name: tenant.name }));
      void navigate({ to: homeTo() });
    },
    [activeTenant?.id, navigate, setActiveTenant, t],
  );

  return { enter, activeTenantId: activeTenant?.id ?? null };
}
