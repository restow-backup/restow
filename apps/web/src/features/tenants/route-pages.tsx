import { RequireRole } from "@/components/require-role";

import { InvitationPage } from "./invitation-page";
import { MembersPage } from "./members-page";
import { TenantDetailPage } from "./tenant-detail-page";
import { TenantsPage } from "./tenants-page";

/**
 * Role gates of the tenants feature. Tenant management is the provider's
 * job; a tenant's own admins manage its members; every signed-in person may
 * answer an invitation addressed to them. The sidebar hides what a role may
 * not open, and a direct link shows the standard "not permitted" notice.
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

export function TenantDetailRoutePage({ tenantId }: { tenantId: string }) {
  return (
    <RequireRole roles={TENANT_MANAGEMENT_ROLES}>
      {/* Keyed by id so moving between tenants starts from a clean state. */}
      <TenantDetailPage key={tenantId} tenantId={tenantId} />
    </RequireRole>
  );
}

export function MembersRoutePage() {
  return (
    <RequireRole roles={MEMBER_MANAGEMENT_ROLES}>
      <MembersPage />
    </RequireRole>
  );
}

export function InvitationRoutePage({ invitationId }: { invitationId: string }) {
  return <InvitationPage key={invitationId} invitationId={invitationId} />;
}
