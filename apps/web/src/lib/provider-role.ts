import type { ProviderRole } from "@/lib/api";
import type { SessionContextValue } from "@/lib/session";

/**
 * What the signed-in provider admin's team role allows, for hiding what the
 * API would refuse anyway (apps/api lib/provider-access.ts has the rules; this
 * mirrors their ranking only). A provider admin without a team role reported
 * (an older server) counts as an owner, exactly as the API treats them.
 */

const RANK: Record<ProviderRole, number> = {
  read_only: 1,
  technician: 2,
  administrator: 3,
  owner: 4,
};

export const PROVIDER_ROLES: readonly ProviderRole[] = [
  "owner",
  "administrator",
  "technician",
  "read_only",
];

type ProviderSession = Pick<
  SessionContextValue,
  "isProviderAdmin" | "providerRole" | "providerAllTenants"
>;

/** True when `role` grants at least what `minimum` requires. */
export function providerRoleSatisfies(role: ProviderRole, minimum: ProviderRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * Whether the session is a provider admin whose team role reaches `minimum`.
 * `everyTenant` additionally requires the role to cover every tenant (for
 * installation-wide actions such as creating a tenant).
 */
export function providerMay(
  session: ProviderSession,
  minimum: ProviderRole,
  options: { everyTenant?: boolean } = {},
): boolean {
  if (!session.isProviderAdmin) {
    return false;
  }
  const role = session.providerRole ?? "owner";
  if (!providerRoleSatisfies(role, minimum)) {
    return false;
  }
  return !options.everyTenant || (session.providerAllTenants ?? true);
}
