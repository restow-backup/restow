/**
 * Role model (pure functions, no I/O).
 *
 * Restow knows three roles (docs/ARCHITECTURE.md, Mandantenmodell):
 *   - `provider_admin` — installation-wide. Backed by the better-auth admin plugin:
 *     `user.role === "admin"`. May act on every tenant.
 *   - `tenant_admin`   — owner/admin of one tenant. Backed by an organization
 *     membership with role `owner` or `admin`.
 *   - `tenant_user`    — plain member of one tenant (self-service restore only).
 *
 * better-auth stores membership roles as a comma-separated list (`parseRoles`),
 * so every mapping here tolerates multi-role strings.
 */

export const ROLES = ["provider_admin", "tenant_admin", "tenant_user"] as const;
export type Role = (typeof ROLES)[number];

/** Roles a user can hold inside a tenant (the provider role is global, not per tenant). */
export type TenantRole = Exclude<Role, "provider_admin">;

/** better-auth admin plugin: users whose `role` contains this are global admins. */
export const PROVIDER_ADMIN_USER_ROLE = "admin";

/** Organization roles that grant tenant administration. */
const ORGANIZATION_ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Split a better-auth role value (`"owner"`, `"admin,member"`, null) into its parts. */
export function splitRoles(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((role) => role.trim().toLowerCase())
    .filter((role) => role.length > 0);
}

/** True when the better-auth `user.role` marks a global (provider) admin. */
export function isProviderAdminRole(userRole: string | null | undefined): boolean {
  return splitRoles(userRole).includes(PROVIDER_ADMIN_USER_ROLE);
}

/** Map an organization membership role onto the Restow tenant role. */
export function tenantRoleFromMembership(memberRole: string | null | undefined): TenantRole {
  const roles = splitRoles(memberRole);
  return roles.some((role) => ORGANIZATION_ADMIN_ROLES.has(role)) ? "tenant_admin" : "tenant_user";
}

/** Map a Restow tenant role onto the organization role better-auth stores. */
export function membershipRoleFromTenantRole(role: TenantRole): "admin" | "member" {
  return role === "tenant_admin" ? "admin" : "member";
}

/** Ordering used for "at least this role" checks; higher wins. */
const ROLE_RANK: Record<Role, number> = {
  tenant_user: 1,
  tenant_admin: 2,
  provider_admin: 3,
};

/** True when `role` grants at least what `minimum` requires. */
export function roleSatisfies(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** Anyone who administers a tenant: the tenant's own admins and the provider. */
export function isTenantAdmin(role: Role): boolean {
  return roleSatisfies(role, "tenant_admin");
}

/**
 * The role shown on `/me`: provider admins are global; everybody else is summarized
 * by their strongest membership, defaulting to `tenant_user` when they have none.
 */
export function globalRole(userRole: string | null | undefined, membershipRoles: string[]): Role {
  if (isProviderAdminRole(userRole)) {
    return "provider_admin";
  }
  return membershipRoles.some((role) => tenantRoleFromMembership(role) === "tenant_admin")
    ? "tenant_admin"
    : "tenant_user";
}

export interface TenantAccessInput {
  /** The requester is a provider admin (global). */
  isProviderAdmin: boolean;
  /** The requester's membership role in the tenant's organization, if any. */
  membershipRole: string | null;
  /** Minimum role the route requires. */
  minimumRole: TenantRole;
}

export type TenantAccessDecision =
  | { allowed: true; role: Role }
  | { allowed: false; reason: "not_a_member" | "insufficient_role"; role: Role | null };

/**
 * Decide whether a requester may enter a tenant context and with which effective
 * role. Provider admins always enter as `provider_admin`; members enter with their
 * mapped tenant role; non-members are rejected.
 */
export function decideTenantAccess(input: TenantAccessInput): TenantAccessDecision {
  if (input.isProviderAdmin) {
    return { allowed: true, role: "provider_admin" };
  }
  if (input.membershipRole === null) {
    return { allowed: false, reason: "not_a_member", role: null };
  }
  const role = tenantRoleFromMembership(input.membershipRole);
  if (!roleSatisfies(role, input.minimumRole)) {
    return { allowed: false, reason: "insufficient_role", role };
  }
  return { allowed: true, role };
}
