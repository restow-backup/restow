import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, redirect } from "@tanstack/react-router";

import { ShellSkeleton } from "@/components/layout/shell-skeleton";
import { applyDemoLanguage } from "@/i18n";
import { ApiError, type Me, queryKeys, setupStateQueryOptions } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { applyProductName } from "@/lib/branding";
import {
  AUTHENTICATOR_SETUP_PATH,
  HOME_PATH,
  loginRedirectFor,
  resolveEntryRedirect,
  safeRedirectTarget,
} from "@/lib/entry";
import type { NavItem } from "@/lib/navigation";
import { isEnrollmentRequiredError, requiresAuthenticatorEnrollment } from "@/lib/second-factor";
import { meQueryOptions, sessionQueryOptions } from "@/lib/session";
import { AppErrorPage, AppLayout } from "@/routes/app-layout";
import { RootNotFoundPage } from "@/routes/not-found";
import { RootErrorPage, RootLayout, RootPendingPage } from "@/routes/root";

/**
 * The two routes every feature hangs off. Feature modules import
 * `appLayoutRoute` as the parent of their pages; `router.tsx` assembles the
 * tree. Keeping them here (and not in `router.tsx`) avoids import cycles.
 */

/** Context available to every route (loaders can reach the query cache). */
export interface RouterContext {
  queryClient: QueryClient;
  /** Sidebar entries: base items plus everything from `features/registry.ts`. */
  navItems: readonly NavItem[];
}

/** Re-exported so existing imports from "@/routes/tree" keep working; defined in lib/api.ts. */
export { setupStateQueryOptions };

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  // First-run gate: until the installation is configured every path leads
  // to the wizard, afterwards the wizard is closed.
  beforeLoad: async ({ context, location }) => {
    const setupState = await context.queryClient.ensureQueryData(setupStateQueryOptions);
    // Before anything renders: every text names the product the installation is branded with.
    applyProductName(setupState.productName);
    // The public demo starts in English unless the visitor picked a language.
    applyDemoLanguage(setupState.demo?.enabled === true);
    const target = resolveEntryRedirect(setupState.configured, location.pathname);
    if (target) {
      throw redirect({ to: target, replace: true });
    }
    return { setupState };
  },
  component: RootLayout,
  pendingComponent: RootPendingPage,
  errorComponent: RootErrorPage,
  notFoundComponent: RootNotFoundPage,
});

/**
 * Pathless layout for the authenticated shell (sidebar, top bar). While its
 * guard loads the session and profile the shell-shaped skeleton shows; if the
 * shell cannot be set up, a standalone error page with a retry. A failing
 * page below it stays inside the shell (see `ShellOutlet` in app-layout.tsx).
 */
export const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (!session) {
      throw toLogin(location.href);
    }
    const setupState = await context.queryClient.ensureQueryData(setupStateQueryOptions);
    // A password alone only lets the account enrol its authenticator app —
    // except the demo account in demo mode, which needs none (lib/second-factor.ts).
    if (requiresAuthenticatorEnrollment(session, setupState.demo)) {
      throw toAuthenticatorSetup(location.href);
    }
    // Seed the reactive better-auth store so the shell does not refetch.
    authClient.hydrateSession(session);

    let me: Me;
    try {
      me = await context.queryClient.ensureQueryData(meQueryOptions);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        context.queryClient.removeQueries({ queryKey: queryKeys.authSession });
        throw toLogin(location.href);
      }
      if (isEnrollmentRequiredError(error)) {
        context.queryClient.removeQueries({ queryKey: queryKeys.authSession });
        throw toAuthenticatorSetup(location.href);
      }
      throw error;
    }
    return { session, me };
  },
  component: AppLayout,
  pendingComponent: ShellSkeleton,
  errorComponent: AppErrorPage,
});

function toAuthenticatorSetup(href: string) {
  const target = safeRedirectTarget(href);
  return redirect({
    to: AUTHENTICATOR_SETUP_PATH,
    search: target && target !== HOME_PATH ? { redirect: target } : {},
    replace: true,
  });
}

function toLogin(href: string) {
  const { to, redirect: target } = loginRedirectFor(href);
  return redirect({ to, search: target ? { redirect: target } : {}, replace: true });
}
