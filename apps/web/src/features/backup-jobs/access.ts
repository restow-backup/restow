import { type WriteBlock, useTenantWriteBlock } from "@/features/tenant-page/access";

/**
 * Who may create, change, run and delete jobs. Reading the jobs is for the
 * tenant's administrators and every provider role (the pages are gated by role
 * already). Changing them needs a tenant administrator or a provider admin
 * whose team role is Administrator or higher (apps/api lib/provider-access.ts
 * `configure`), and the public demo closes every change. A closed page is the
 * same page with its controls disabled and one sentence on top, never an error.
 */
export type JobsWriteBlock = WriteBlock;

/** Why the controls are closed; null when the viewer may change jobs. */
export function useJobsWriteBlock(): JobsWriteBlock | null {
  return useTenantWriteBlock();
}

/**
 * Jobs are for the tenant's administrators and the provider's admins; end users
 * follow their own restores in the restore feature. The sidebar hides the entries
 * for everyone else, and a direct link shows the standard "not permitted" notice
 * instead of a failing request. Other pages (the inventory of machines) offer
 * their job actions to these roles only.
 */
export const JOB_ROLES = ["provider_admin", "tenant_admin"] as const;
