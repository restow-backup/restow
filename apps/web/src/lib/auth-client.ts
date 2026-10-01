import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { type ReactAuthClient, createAuthClient } from "better-auth/react";

/**
 * better-auth React client. It talks to the handler mounted at `/api/auth/*`
 * on the same origin, so the session cookie flows without extra CORS setup.
 * Plugins mirror the server (apps/api/src/auth.ts): passkey (WebAuthn),
 * organization (tenants), admin (provider admin) and two-factor (TOTP on the
 * emergency password path).
 *
 * The option type is spelled out so the compiler can name the client type
 * (`declaration` is on for every workspace) without serialising the plugin
 * internals.
 */
// biome-ignore lint/complexity/noBannedTypes: `{}` is the factories' own "no options" type.
type NoPluginOptions = {};

type ClientPlugins = [
  ReturnType<typeof passkeyClient>,
  // Instantiation expressions pin the generic option parameters to "no
  // options"; a bare `ReturnType` of these generic factories would collapse
  // the plugin union and lose the inferred actions.
  ReturnType<typeof organizationClient<NoPluginOptions>>,
  ReturnType<typeof adminClient<NoPluginOptions>>,
  ReturnType<typeof twoFactorClient>,
];

interface ClientOptions {
  baseURL: string | undefined;
  basePath: string;
  plugins: ClientPlugins;
}

const clientOptions: ClientOptions = {
  baseURL: typeof window === "undefined" ? undefined : window.location.origin,
  basePath: "/api/auth",
  plugins: [passkeyClient(), organizationClient(), adminClient(), twoFactorClient()],
};

export const authClient: ReactAuthClient<ClientOptions> = createAuthClient(clientOptions);

export type AuthSession = ReactAuthClient<ClientOptions>["$Infer"]["Session"];

/** The `{ data, error }` envelope every better-auth client call resolves to. */
export interface AuthResult<T> {
  data: T | null;
  error: { message?: string; code?: string; status: number; statusText: string } | null;
}

/**
 * Sign-in responses carry `twoFactorRedirect: true` when the account has an
 * authenticator enrolled and the TOTP step is still outstanding.
 */
export function needsSecondFactor(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
  );
}

/** Whether the browser can run a WebAuthn ceremony at all. */
export function browserSupportsPasskeys(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.get === "function"
  );
}
