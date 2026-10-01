import type { Role, TenantRole } from "@/lib/api";

/**
 * Module-level active tenant. `apiFetch` reads it for the `X-Restow-Tenant`
 * header, so every tenant-scoped request follows the switcher without each
 * caller threading the id through. The choice is remembered per browser so a
 * provider admin lands on the tenant they last looked at.
 *
 * The same module answers which role applies while a tenant is active: the
 * API decides every request with the role in the tenant the header names, so
 * the navigation and the page gates must use that role too, never the highest
 * role the person holds somewhere else.
 */

const STORAGE_KEY = "restow.activeTenant";

let activeTenantId: string | null = null;

export function getActiveTenantId(): string | null {
  return activeTenantId;
}

/**
 * Make `tenantId` the tenant of every following request and remember it.
 * `null` (no tenant known yet, for instance while the profile loads after a
 * reload) only clears the header: the remembered choice must survive until
 * the tenant list is there to pick it again.
 */
export function setActiveTenantId(tenantId: string | null): void {
  activeTenantId = tenantId;
  if (!tenantId) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, tenantId);
  } catch {
    // Storage may be unavailable (private mode, blocked site data); the
    // in-memory value still applies for this page load.
  }
}

/** Drop the active tenant and the remembered choice (on sign-out). */
export function forgetActiveTenant(): void {
  activeTenantId = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing remembered that could be removed.
  }
}

export function readRememberedTenantId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Lifecycle state of a tenant as `GET /api/v1/me` and `GET /tenants` report it. */
export type TenantStatus = "active" | "suspended" | "deleting";

/**
 * Whether a person can work in a tenant with this status. Suspended and
 * deleting tenants refuse everyone except provider admins (the API answers
 * 403 "Tenant suspended").
 */
export function canEnterTenant(status: TenantStatus, isProviderAdmin: boolean): boolean {
  return status === "active" || isProviderAdmin;
}

/**
 * Pick the tenant to activate from the tenants on offer and the ids in order
 * of preference (the explicit choice, the remembered one, the server hint).
 * The first preferred tenant the person can enter wins, then the first one
 * they can enter, then (when every tenant is closed to them) the first one at
 * all, so the shell can say why nothing loads instead of showing no tenant.
 */
export function pickActiveTenant<T extends { id: string }>(
  available: readonly T[],
  preferred: readonly (string | null | undefined)[],
  canEnter: (tenant: T) => boolean = () => true,
): T | null {
  for (const id of preferred) {
    if (!id) continue;
    const match = available.find((tenant) => tenant.id === id);
    if (match && canEnter(match)) {
      return match;
    }
  }
  return available.find(canEnter) ?? available[0] ?? null;
}

/**
 * The role that applies while `activeTenant` is active. A provider admin acts
 * as provider admin in every tenant (as the API does); everyone else has the
 * role of their membership in that tenant. Without an active tenant there is
 * no tenant role at all, so only ungated entries remain.
 */
export function roleInActiveTenant(
  isProviderAdmin: boolean,
  activeTenant: { role: TenantRole } | null,
): Role | null {
  if (isProviderAdmin) {
    return "provider_admin";
  }
  return activeTenant?.role ?? null;
}
