import { type GenericOAuthConfig, genericOAuth } from "better-auth/plugins";
import type { EntraConfig } from "../../../../apps/api/src/config.js";
import type { SignInSettings } from "../../../../apps/api/src/lib/sign-in-options.js";

/**
 * Microsoft (Entra ID) sign-in for end users (Business and Service Provider,
 * `auth.microsoftSso`): the better-auth generic OAuth plugin against the
 * multi-tenant Entra ID `common` endpoint.
 *
 * This module is imported by ./auth.ts before the core builds its better-auth
 * instance, so it must never import anything that reaches
 * apps/api/src/auth.ts (or the database pools). The capability gate and the
 * availability check live in ./access.ts.
 */

/** The better-auth provider id of the Microsoft (Entra ID) sign-in. */
export const MICROSOFT_PROVIDER_ID = "microsoft";

/** OIDC discovery document of the multi-tenant Entra ID `common` endpoint. */
export const MICROSOFT_DISCOVERY_URL =
  "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration";

/**
 * The Microsoft sign-in for end users. It signs in people Restow already knows
 * (a user with a linked Microsoft account) and never creates a user for an
 * unknown Entra account: `disableImplicitSignUp` stops the implicit sign-up,
 * `disableSignUp` also refuses the explicit one a client could ask for with
 * `requestSignUp`. Who gets an account is decided on the server, from the
 * tenant's directory, not by whoever completes a Microsoft sign-in.
 */
export function microsoftSignIn(
  entra: Pick<EntraConfig, "ssoClientId" | "ssoClientSecret">,
): GenericOAuthConfig {
  return {
    providerId: MICROSOFT_PROVIDER_ID,
    clientId: entra.ssoClientId ?? "",
    clientSecret: entra.ssoClientSecret ?? "",
    discoveryUrl: MICROSOFT_DISCOVERY_URL,
    scopes: ["openid", "profile", "email", "offline_access"],
    disableImplicitSignUp: true,
    disableSignUp: true,
  };
}

/** The better-auth plugin carrying the Microsoft sign-in. */
export function microsoftSignInPlugin(entra: Pick<EntraConfig, "ssoClientId" | "ssoClientSecret">) {
  return genericOAuth({ config: [microsoftSignIn(entra)] });
}

/**
 * Sign-in with Microsoft is offered only when the experimental switch is on
 * (`RESTOW_EXPERIMENTAL_MICROSOFT_SIGN_IN`, see `EntraConfig.ssoExperimental`: no
 * screen of this release links an account to a Microsoft identity, so the
 * sign-in is unusable and stays hidden), with the SSO app configured and the
 * installation in public mode with a public URL: Entra accepts HTTPS redirect
 * URIs only, and the OIDC callback hangs off the public URL
 * (docs/ENTRA-SETUP.md, part 6). The edition is checked separately
 * (./access.ts).
 */
export function microsoftSignInConfigured(
  entra: Pick<EntraConfig, "ssoClientId" | "ssoClientSecret" | "ssoExperimental">,
  settings: SignInSettings | null,
): boolean {
  return (
    entra.ssoExperimental &&
    Boolean(entra.ssoClientId) &&
    Boolean(entra.ssoClientSecret) &&
    settings?.operatingMode === "public" &&
    Boolean(settings.publicUrl)
  );
}

/**
 * better-auth paths that serve the Microsoft sign-in (the generic OAuth plugin
 * registers its provider as a social provider as well). No other plugin of
 * the core uses the social sign-in, so closing these paths closes exactly the
 * Microsoft sign-in.
 */
export const MICROSOFT_SIGN_IN_PATHS = [
  "/api/auth/sign-in/social",
  "/api/auth/sign-in/oauth2",
  "/api/auth/link-social",
  "/api/auth/oauth2/*",
  `/api/auth/callback/${MICROSOFT_PROVIDER_ID}`,
] as const;
