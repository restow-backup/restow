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
const SCOPE_KEY = "restow.scope";

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

/** Drop the active tenant and the remembered choices (on sign-out). */
export function forgetActiveTenant(): void {
  activeTenantId = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SCOPE_KEY);
  } catch {
    // Nothing remembered that could be removed.
  }
}

/**
 * What the session works on: one tenant (the default), or "All tenants", the
 * view across every tenant that only the overview has. The active tenant stays
 * what it was while the scope is "all", so nothing that needs a tenant loses
 * its header; the scope is remembered per browser next to it.
 */
export type SessionScope = "tenant" | "all";

export function readRememberedScope(): SessionScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "tenant";
  } catch {
    return "tenant";
  }
}

export function rememberScope(scope: SessionScope): void {
  try {
    if (scope === "all") {
      localStorage.setItem(SCOPE_KEY, "all");
    } else {
      localStorage.removeItem(SCOPE_KEY);
    }
  } catch {
    // Storage may be unavailable; the scope still applies for this page load.
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

/**
 * The tenant that is active in the browser, before the session provider has
 * decided: the choice made on this page (module state), the remembered one,
 * then the server's hint, the first of them the person can enter. Used where
 * an address has to name a tenant before any page renders (the redirects of old
 * addresses); `null` when the person has no tenant to enter.
 */
export function activeTenantIdFor(
  me:
    | {
        role: Role;
        /** A profile from an older server carries no status: such a tenant counts as active. */
        tenants: readonly { id: string; status?: TenantStatus }[];
        activeTenantId: string | null;
      }
    | undefined,
): string | null {
  const preferred = [getActiveTenantId(), readRememberedTenantId(), me?.activeTenantId];
  if (!me) {
    return preferred.find((id): id is string => typeof id === "string" && id.length > 0) ?? null;
  }
  const isProviderAdmin = me.role === "provider_admin";
  return (
    pickActiveTenant(me.tenants, preferred, (tenant) =>
      canEnterTenant(tenant.status ?? "active", isProviderAdmin),
    )?.id ?? null
  );
}
