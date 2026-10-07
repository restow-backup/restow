import { useNavigate, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/ui/sonner";
import { type SessionTenant, useSession } from "@/lib/session";

/**
 * A link that names its tenant: `?forTenant=<id>` on any page (the links of chat and webhook
 * messages, alert mails). The page shows that tenant, not the one this browser had chosen last.
 * Only a tenant the viewer may work in is switched to; for any other the parameter is dropped
 * with a note, and the page shows what it would have shown anyway (its own access rules apply).
 */
export const TENANT_ADDRESS_PARAM = "forTenant";

export type AddressedTenant =
  | { kind: "none" }
  | { kind: "current" }
  | { kind: "switch"; tenantId: string }
  | { kind: "denied" };

export function addressedTenant(
  value: unknown,
  tenants: readonly Pick<SessionTenant, "id">[],
  activeTenantId: string | null,
  allTenantsScope: boolean,
): AddressedTenant {
  if (typeof value !== "string" || value.length === 0) {
    return { kind: "none" };
  }
  if (!tenants.some((tenant) => tenant.id === value)) {
    return { kind: "denied" };
  }
  return value === activeTenantId && !allTenantsScope
    ? { kind: "current" }
    : { kind: "switch", tenantId: value };
}

/** Applies `?forTenant=` once the session is known, then removes it from the address. */
export function TenantFromAddress() {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const search = location.search as Record<string, unknown>;
  const requested = search[TENANT_ADDRESS_PARAM];

  React.useEffect(() => {
    if (requested === undefined || session.status !== "authenticated") {
      return;
    }
    const decision = addressedTenant(
      requested,
      session.tenants,
      session.activeTenant?.id ?? null,
      session.scope === "all",
    );
    if (decision.kind === "switch") {
      session.setActiveTenant(decision.tenantId);
    } else if (decision.kind === "denied") {
      toast.warning(t("errors.tenantNotAccessible"));
    }
    const { [TENANT_ADDRESS_PARAM]: _dropped, ...rest } = search;
    void navigate({ to: location.pathname as never, search: rest as never, replace: true });
  }, [requested, session, search, location.pathname, navigate, t]);

  return null;
}
