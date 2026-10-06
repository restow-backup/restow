/**
 * Entra ID integration for connecting customer tenants: the admin-consent
 * link and its signed state, the callback parser, the sign-in that proves who
 * consented, the application-permission catalogue with its diff, and the
 * verification that acquires a token and makes a first Graph call
 * (docs/ENTRA-SETUP.md, docs/MICROSOFT.md). Also the backup app registration
 * itself: where its credentials come from (the environment, or the sealed
 * document saved in the web UI), the certificate checks and the connection test.
 *
 * The client-credentials token provider itself lives in ../graph/auth; the
 * pieces this module needs are re-exported so consumers have one import.
 */
export * from "./permissions.js";
export * from "./consent-state.js";
export * from "./consent.js";
export * from "./consent-identity.js";
export * from "./verify.js";
export * from "./certificate.js";
export * from "./app-registration.js";
export * from "./app-test.js";
export * from "./source-app.js";
export {
  type AccessTokenProvider,
  type AppCredentials,
  type ClientCredential,
  ClientCredentialsTokenProvider,
  TenantTokenProviders,
  TokenAcquisitionError,
  certificateThumbprintSha1Hex,
} from "../graph/auth/token.js";
