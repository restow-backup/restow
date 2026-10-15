import { JOBS_PATH } from "@/features/backup-jobs/paths";

export { TenantJobsOverview } from "./tenant-jobs-overview.js";

/**
 * The "All tenants" view of Jobs (#63) replaces the plain choice of a tenant on the two job
 * lists (Jobs under Mail & SaaS and under Servers & clients). A job's own page still asks for
 * its tenant. Returns the list's area, or null when the page is not one of them.
 */
export function jobsOverviewArea(
  entryId: string | null,
  pathname: string,
): "mail" | "endpoint" | null {
  if (pathname !== JOBS_PATH) {
    return null;
  }
  return entryId === "mail-jobs" ? "mail" : entryId === "endpoint-jobs" ? "endpoint" : null;
}
