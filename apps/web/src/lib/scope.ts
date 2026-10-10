import { REPOSITORIES_NAV_ID, TENANT_SETTINGS_NAV_IDS } from "@/lib/tenant-nav";

/**
 * The pages that only exist per tenant. While the session works on "All
 * tenants" (lib/tenant.ts `SessionScope`) the overview and Recovery readiness
 * look across every tenant; everything here needs one tenant (its requests carry
 * `X-Restow-Tenant`), so the menu dims these entries and a page opened anyway
 * says "choose a tenant" instead of failing (components/layout/choose-tenant.tsx).
 * Keyed by the id of the menu entry, which also covers the pages below an entry
 * (a restore job, a run in History).
 *
 * Not listed, because they work without a tenant: the overview, Recovery
 * readiness and Alerts (they have an all-tenants view), "Manage tenants", the tenant page
 * (it names its tenant) and everything under Installation.
 */
export const TENANT_ONLY_NAV_IDS: readonly string[] = [
  "mail-jobs",
  "endpoint-jobs",
  "history",
  "warnings",
  "restore",
  "archive",
  "exports",
  "inventory",
  "file-restore",
  ...TENANT_SETTINGS_NAV_IDS,
  REPOSITORIES_NAV_ID,
];

/** Pages below an entry of their own, or without one, that still belong to one tenant (a readiness report, the warnings). */
const TENANT_ONLY_PATH_PREFIXES: readonly string[] = ["/verify/reports", "/warnings"];

/** Whether the menu entry is one that needs a tenant. */
export function isTenantOnlyNavItem(id: string): boolean {
  return TENANT_ONLY_NAV_IDS.includes(id);
}

/** Whether the page at `pathname`, which belongs to the menu entry `entryId`, needs a tenant. */
export function isTenantOnlyPage(entryId: string | null, pathname: string): boolean {
  return (
    (entryId !== null && isTenantOnlyNavItem(entryId)) ||
    TENANT_ONLY_PATH_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  );
}
