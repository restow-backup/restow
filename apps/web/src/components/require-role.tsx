import { ShieldAlert } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { canAccess, useSession } from "@/lib/session";

interface RequireRoleProps {
  /** Roles allowed to see the children; empty or omitted means everyone. */
  roles?: readonly string[];
  /** Rendered instead of the default notice when access is denied. */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Render-time role gate for pages and sections. It checks the role in the
 * active tenant, the role the API applies to every request, and names it
 * when access is denied, so a person who administers another tenant
 * understands why this one is closed to them.
 */
export function RequireRole({ roles, fallback, children }: RequireRoleProps) {
  const { t } = useTranslation();
  const { role, activeTenant } = useSession();

  if (canAccess(role, roles)) {
    return <>{children}</>;
  }
  if (fallback !== undefined) {
    return <>{fallback}</>;
  }
  return (
    <Alert variant="warning">
      <ShieldAlert />
      <AlertTitle>{t("errors.forbiddenTitle")}</AlertTitle>
      <AlertDescription>
        <p>{t("errors.forbidden")}</p>
        {role && activeTenant ? (
          <p>{t("errors.roleInTenant", { tenant: activeTenant.name, role: t(`roles.${role}`) })}</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
