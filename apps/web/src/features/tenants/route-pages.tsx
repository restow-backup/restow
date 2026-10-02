import { RequireRole } from "@/components/require-role";

import { InvitationPage } from "./invitation-page";
import { TenantsPage } from "./tenants-page";

/**
 * Role gates of the tenants feature. Tenant management is the provider's
 * job; every signed-in person may answer an invitation addressed to them. The
 * sidebar hides what a role may not open, and a direct link shows the
 * standard "not permitted" notice. One tenant's own page (its overview,
 * members and master data) is the tenant page (features/tenant-page).
 */
export const TENANT_MANAGEMENT_ROLES = ["provider_admin"] as const;
export const MEMBER_MANAGEMENT_ROLES = ["provider_admin", "tenant_admin"] as const;

export function TenantsRoutePage() {
  return (
    <RequireRole roles={TENANT_MANAGEMENT_ROLES}>
      <TenantsPage />
    </RequireRole>
  );
}

export function InvitationRoutePage({ invitationId }: { invitationId: string }) {
  return <InvitationPage key={invitationId} invitationId={invitationId} />;
}
