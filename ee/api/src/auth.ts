import { config } from "../../../apps/api/src/config.js";
import type { AuthExtension } from "../../../apps/api/src/extensions.js";
import { microsoftSignInPlugin } from "./sso/config.js";

/**
 * The better-auth plugins of the Business and Service Provider modules,
 * registered by apps/api/src/ee.ts before the better-auth instance is built.
 * Nothing imported from here may reach apps/api/src/auth.ts.
 *
 * The Microsoft sign-in plugin is always registered; whether its paths answer
 * is decided per request by the `auth.microsoftSso` capability
 * (./sso/access.ts).
 */
export const eeAuthExtension: AuthExtension = {
  plugins: [microsoftSignInPlugin(config.entra)],
};
