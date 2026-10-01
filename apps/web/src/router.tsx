import { createRoute, createRouter, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { setPasswordRoute } from "@/features/accounts";
import * as dashboard from "@/features/dashboard";
import { featureNavItems, featureRoutes } from "@/features/registry";
import { AUTHENTICATOR_SETUP_PATH, HOME_PATH, LOGIN_PATH, safeRedirectTarget } from "@/lib/entry";
import type { NavItem } from "@/lib/navigation";
import { queryClient } from "@/lib/query";
import { requiresAuthenticatorEnrollment } from "@/lib/second-factor";
import { sessionQueryOptions } from "@/lib/session";
import { AuthenticatorSetupPage } from "@/routes/authenticator-setup";
import { LoginPage } from "@/routes/login";
import { NotFoundPage } from "@/routes/not-found";
import { SetupPage } from "@/routes/setup";
import {
  type RouterContext,
  appLayoutRoute,
  rootRoute,
  setupStateQueryOptions,
} from "@/routes/tree";

/**
 * Route tree: `rootRoute` (first-run gate) -> `/setup`, `/login`, the
 * mandatory authenticator enrolment and the authenticated shell with the
 * dashboard plus every registered feature.
 */

const redirectSearchSchema = z.object({
  /** App-internal path to return to after signing in. */
  redirect: z.string().optional(),
});

const loginSearchSchema = redirectSearchSchema.extend({
  /** Error code of a failed sign-in with Microsoft (set by better-auth). */
  error: z.string().optional(),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) => loginSearchSchema.parse(search),
  // Already signed in: there is nothing to do on the login page.
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (session) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: LoginPage,
});

const authenticatorSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: AUTHENTICATOR_SETUP_PATH,
  validateSearch: (search: Record<string, unknown>) => redirectSearchSchema.parse(search),
  // Only a password-only session has anything to do here.
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (!session) {
      throw redirect({ to: LOGIN_PATH, replace: true });
    }
    const setupState = await context.queryClient.ensureQueryData(setupStateQueryOptions);
    if (!requiresAuthenticatorEnrollment(session, setupState.demo)) {
      throw redirect({ to: safeRedirectTarget(search.redirect) ?? HOME_PATH, replace: true });
    }
  },
  component: AuthenticatorSetupPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

// Unknown paths still go through the shell guard: anonymous visitors land on
// the login page, signed-in users see the not-found page inside the shell.
const catchAllRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "$",
  component: NotFoundPage,
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  authenticatorSetupRoute,
  setPasswordRoute,
  appLayoutRoute.addChildren([...dashboard.routes, ...featureRoutes, catchAllRoute]),
]);

const navItems: readonly NavItem[] = [...dashboard.navItems, ...featureNavItems];

const context: RouterContext = { queryClient, navItems };

export const router = createRouter({
  routeTree,
  context,
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  defaultPendingMs: 300,
  defaultPendingMinMs: 200,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
