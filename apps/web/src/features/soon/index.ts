import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { createElement } from "react";

import { redirectTo } from "@/features/redirects";
import { jobsTarget } from "@/features/redirects/targets";
import { appLayoutRoute } from "@/routes/tree";

import {
  JOBS_PATH,
  RESOURCES_PATH,
  isJobType,
  jobsSoonItem,
  resourcesSoonItem,
  soonNavItems,
} from "./items";
import { SoonPage } from "./soon-page";

export { SoonPage } from "./soon-page";
export { JOBS_PATH, RESOURCES_PATH, SOON_CONTENT, soonNavItems } from "./items";

/**
 * Pages of features that come with a later release (items.ts): the job
 * definitions (`/jobs?type=mail|endpoint`, 0.2.0) and Resources
 * (`/resources`, 0.2.1). `/jobs` without a job type is the old address of the
 * run list and leads to History, keeping its query.
 */
export function createSoonRoutes(getParentRoute: () => AnyRoute): AnyRoute[] {
  const parent = getParentRoute as () => typeof appLayoutRoute;
  const jobs = createRoute({
    getParentRoute: parent,
    path: JOBS_PATH,
    // Keep every parameter: the redirect passes the run list's query on.
    validateSearch: (search: Record<string, unknown>) => search,
    beforeLoad: ({ location }) => {
      const search = location.search as Record<string, unknown>;
      if (!isJobType(search.type)) {
        redirectTo(jobsTarget(search));
      }
    },
    component: function JobsSoonRoute() {
      const { type } = jobs.useSearch() as { type?: unknown };
      return isJobType(type) ? createElement(SoonPage, { item: jobsSoonItem(type) }) : null;
    },
  });
  const resources = createRoute({
    getParentRoute: parent,
    path: RESOURCES_PATH,
    component: () => createElement(SoonPage, { item: resourcesSoonItem() }),
  });
  return [jobs, resources];
}

export const routes: AnyRoute[] = createSoonRoutes(() => appLayoutRoute);

export const navItems = soonNavItems;
