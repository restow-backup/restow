import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";

import { redirectTo } from "@/features/redirects";
import { jobsTarget } from "@/features/redirects/targets";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n.js";
import { JOBS_PATH, JOB_DEFINITION_PATTERN, isJobKind } from "./paths.js";
import { JOB_ROLES, JobDetailRoute, JobsRoute } from "./route-pages.js";

/**
 * Backup jobs (release 0.2.0): the definitions of what is backed up, when and
 * how, over many objects or machines (docs/ARCHITECTURE.md, "Jobs"). One job is a
 * template with overrides per object. The jobs are listed per kind at
 * `/jobs?type=mail|endpoint` (the two menu entries named Jobs, under Mail & SaaS
 * and under Servers & endpoints), one job lives at `/jobs/definitions/<id>`, and
 * the editor opens on the list with `?new=1` (see paths.ts). The runs of the jobs
 * are History (features/jobs); `/jobs` without a kind is the old address of the
 * run list and leads there, keeping its query.
 */

export { JOB_ROLES };

/** The routes below `getParentRoute` (the shell; a bare root in tests). */
export function createBackupJobRoutes(getParentRoute: () => AnyRoute): AnyRoute[] {
  const parent = getParentRoute as () => typeof appLayoutRoute;
  const list = createRoute({
    getParentRoute: parent,
    path: JOBS_PATH,
    // Keep every parameter: the redirect to History passes the run list's query on.
    validateSearch: (search: Record<string, unknown>) => search,
    beforeLoad: ({ location }) => {
      const search = location.search as Record<string, unknown>;
      if (!isJobKind(search.type)) {
        redirectTo(jobsTarget(search));
      }
    },
    component: JobsRoute,
  });
  const detail = createRoute({
    getParentRoute: parent,
    path: JOB_DEFINITION_PATTERN,
    validateSearch: (search: Record<string, unknown>) => search,
    component: JobDetailRoute,
  });
  return [list, detail];
}

export const routes: AnyRoute[] = createBackupJobRoutes(() => appLayoutRoute);

export const navItems: NavItem[] = [
  {
    id: "mail-jobs",
    path: JOBS_PATH,
    search: { type: "mail" },
    labelKey: "nav.items.jobs",
    icon: ListChecks,
    roles: [...JOB_ROLES],
    group: "mail",
    order: 10,
  },
  {
    id: "endpoint-jobs",
    path: JOBS_PATH,
    search: { type: "endpoint" },
    labelKey: "nav.items.jobs",
    icon: ListChecks,
    roles: [...JOB_ROLES],
    group: "endpoints",
    order: 10,
  },
];
