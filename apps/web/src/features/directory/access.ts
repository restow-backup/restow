/**
 * Who may manage the protection directory: provider admins and tenant admins
 * (the API requires the tenant_admin role for every directory endpoint).
 */
export const DIRECTORY_ROLES = ["provider_admin", "tenant_admin"] as const;
