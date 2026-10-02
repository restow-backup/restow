import { type AnyRoute, createRoute, redirect } from "@tanstack/react-router";

import { installationSections } from "@/features/installation/sections";
import type { Me } from "@/lib/api";
import { activeTenantIdFor } from "@/lib/tenant";
import { appLayoutRoute } from "@/routes/tree";

import { type RedirectTarget, legacyTarget } from "./targets";

export { legacyTarget } from "./targets";

/**
 * Routes on the old addresses of moved pages (targets.ts). They sit below the
 * shell, so a signed-out visitor signs in first and then lands on the new
 * page. `/jobs` itself is not here: it is the address of the job
 * definitions (features/backup-jobs), which sends an address without a job kind to
 * History itself; `/backup` leads to the mail jobs. `/settings` leads
 * to the installation page; which section depends on the sections the
 * installation has (an extension may claim an old settings tab). The pages of
 * one tenant (`/sources`, `/protected-objects`, `/schedules`, `/retention`,
 * `/imports`, `/members`, `/repositories`, `/integrations` and the pages below
 * them) lead to the section of the tenant page of the tenant that is active in
 * the browser, or of the one the address names.
 */
const LEGACY_PATHS = [
  "/settings",
  "/stats",
  "/jobs/$jobId",
  "/restore/jobs",
  "/reports",
  "/storage",
  "/endpoints/agents",
  "/endpoints/servers",
  "/endpoints/clients",
  "/endpoints/$area/$endpointId",
  "/sources",
  "/sources/import",
  "/sources/$sourceId",
  "/protected-objects",
  "/backup",
  "/schedules",
  "/retention",
  "/imports",
  "/imports/$importId",
  "/members",
  "/repositories",
  "/integrations",
  "/integrations/webhooks/$webhookId",
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
      beforeLoad: ({ location, context }) => {
        // The parent route's guard has loaded the profile; the tenant that is active in the
        // browser is the one the session provider will pick (lib/tenant.ts).
        const me = (context as { me?: Pick<Me, "tenants" | "activeTenantId" | "role"> }).me;
        const target = legacyTarget(
          location.pathname,
          location.search as Record<string, unknown>,
          installationSections(),
          activeTenantIdFor(me),
        );
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
