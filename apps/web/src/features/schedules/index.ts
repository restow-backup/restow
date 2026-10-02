import type { NavItem } from "@/lib/navigation";

import "./i18n.js";

/**
 * Schedules: what runs unattended per tenant besides the backup jobs: the
 * maintenance (integrity checks, directory sync, retention), with the recommended
 * set, next and last runs. Backups and their restore checks are backup jobs since
 * 0.2.0 (features/backup-jobs): schedules a job took over are not listed, an older
 * one no job could take over still is, with a note that it keeps running next to
 * the jobs, and the recommended set also creates the default mail job where none
 * covers all objects. The page is the "Jobs & schedules" section of the tenant
 * page (features/tenant-page), below the tenant's jobs, for the tenant's
 * administrators; the old address `/schedules` leads there (features/redirects).
 * `components/cadence-fields.tsx` is the cadence form the job editor shares.
 */

export const routes = [];

/** No menu entry: the tenant settings entry opens the tenant page. */
export const navItems: NavItem[] = [];
