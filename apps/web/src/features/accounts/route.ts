import { createRoute } from "@tanstack/react-router";
import { createElement } from "react";

import { rootRoute } from "@/routes/tree";

import "./i18n";
import { SET_PASSWORD_BASE_PATH } from "./paths";
import { SetPasswordPage } from "./set-password-page";

/**
 * The public set-password page. Unlike every other feature route it hangs
 * off `rootRoute` directly (outside the authenticated app shell, alongside
 * `/login` and `/setup`), because nobody who opens this link has a session
 * yet. Not part of `featureRoutes`/`featureNavItems` (features/registry.ts):
 * it has no sidebar entry and must not require the shell's session guard, so
 * it is wired into `router.tsx`'s `rootRoute.addChildren([...])` directly
 * (integration wiring request).
 */
export const setPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: `${SET_PASSWORD_BASE_PATH}/$token`,
  component: function SetPasswordRoute() {
    const { token } = setPasswordRoute.useParams();
    return createElement(SetPasswordPage, { token });
  },
});
