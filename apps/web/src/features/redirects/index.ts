import { type AnyRoute, createRoute, redirect } from "@tanstack/react-router";

import { appLayoutRoute } from "@/routes/tree";

import { type RedirectTarget, legacyTarget } from "./targets";

export { legacyTarget } from "./targets";

/**
 * Routes on the old addresses of moved pages (targets.ts). They sit below the
 * shell, so a signed-out visitor signs in first and then lands on the new
 * page. `/jobs` itself is not here: it is the address of the job
 * definitions and shows their placeholder (features/soon).
 */
const LEGACY_PATHS = [
  "/stats",
  "/jobs/$jobId",
  "/restore/jobs",
  "/reports",
  "/storage",
  "/endpoints/agents",
  "/endpoints/servers",
  "/endpoints/clients",
  "/endpoints/$area/$endpointId",
] as const;

/** Throw the router's redirect to `target`, replacing the old entry in the history. */
export function redirectTo(target: RedirectTarget): never {
  throw redirect({ to: target.to as never, search: target.search as never, replace: true });
}

/** The legacy routes below `getParentRoute` (the shell; a bare root in tests). */
export function createLegacyRoutes(getParentRoute: () => AnyRoute): AnyRoute[] {
  return LEGACY_PATHS.map((path) =>
    createRoute({
      getParentRoute: getParentRoute as () => typeof appLayoutRoute,
      path,
      beforeLoad: ({ location }) => {
        const target = legacyTarget(location.pathname, location.search as Record<string, unknown>);
        if (target) {
          redirectTo(target);
        }
      },
      // Never rendered: the guard always leaves.
      component: () => null,
    }),
  );
}

export const routes: AnyRoute[] = createLegacyRoutes(() => appLayoutRoute);

/** No menu entries: these addresses only lead elsewhere. */
export const navItems = [];
