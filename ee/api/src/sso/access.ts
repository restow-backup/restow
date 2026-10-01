import { config } from "../../../../apps/api/src/config.js";
import { db } from "../../../../apps/api/src/db.js";
import type { AuthRouteGuard, SignInProvider } from "../../../../apps/api/src/extensions.js";
import { notFoundHandler } from "../../../../apps/api/src/problem.js";
import { hasCapability } from "../license/gate.js";
import { MICROSOFT_SIGN_IN_PATHS, microsoftSignInConfigured } from "./config.js";

/**
 * Gate of the Microsoft sign-in: the experimental switch
 * (`config.entra.ssoExperimental`, off by default, see ./config.ts) and the
 * edition (`auth.microsoftSso`, Business and Service Provider). The plugin
 * itself is always registered (./auth.ts); the switch is fixed by the
 * environment and the edition is read per request, so installing or removing a
 * license key takes effect without a restart.
 */

/** Without the switch and the capability, every Microsoft sign-in path answers like an unknown path. */
export const microsoftSignInGuard: AuthRouteGuard = {
  paths: MICROSOFT_SIGN_IN_PATHS,
  handler: async (c, next) => {
    if (!config.entra.ssoExperimental || !(await hasCapability(db, "auth.microsoftSso"))) {
      return notFoundHandler(c);
    }
    await next();
  },
};

/** What the login page and the invitation dialog offer (public setup state). */
export const microsoftSignInProvider: SignInProvider = {
  id: "microsoft",
  async available(settings) {
    return (
      microsoftSignInConfigured(config.entra, settings) &&
      (await hasCapability(db, "auth.microsoftSso"))
    );
  },
};
