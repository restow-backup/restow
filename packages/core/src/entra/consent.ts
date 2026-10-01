/**
 * Admin-consent link and callback (docs/ENTRA-SETUP.md, part 4).
 *
 * A customer connects their Microsoft 365 tenant by having a Global Admin open
 * the consent link, sign in to *their* tenant and approve the application
 * permissions of the Restow backup app for the whole organisation. Entra then
 * redirects the admin to Restow's callback with the outcome and the tenant id.
 *
 * The v2.0 admin-consent endpoint is used: it takes the `.default` scope so
 * every application permission configured on the app registration is
 * consented in one go. Its callback *names* a tenant, but Microsoft does not
 * sign that parameter: anyone holding a valid state can put any tenant id
 * there. The callback therefore only yields a claim; the OIDC sign-in in
 * ./consent-identity.ts proves it before a source is bound to any tenant.
 */
import { DEFAULT_AUTHORITY_HOST, GRAPH_DEFAULT_SCOPE } from "../graph/auth/token.js";

/**
 * Path of the consent callback relative to the public origin. The exact URL
 * (origin + path) must be registered as a Web redirect URI on the backup app.
 */
export const ADMIN_CONSENT_CALLBACK_PATH = "/api/v1/sources/m365/consent/callback";

/**
 * Audience for a multi-tenant admin-consent link when the customer's tenant is
 * not known yet: `organizations` excludes personal Microsoft accounts, which
 * cannot grant admin consent anyway.
 */
export const DEFAULT_CONSENT_AUDIENCE = "organizations";

/** A GUID or a verified domain; anything else is not a tenant reference Entra accepts. */
const TENANT_REFERENCE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

const ENTRA_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical Entra tenant id (GUID). */
export function isEntraTenantId(value: string): boolean {
  return ENTRA_GUID.test(value.trim());
}

/**
 * Normalise a tenant reference an admin typed: a tenant id (GUID) or a
 * verified domain such as `contoso.onmicrosoft.com`. Returns null when the
 * value cannot be a tenant reference (so it never ends up in a URL).
 */
export function normalizeTenantReference(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 253 || !TENANT_REFERENCE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** The absolute callback URL for a public origin (docs/ENTRA-SETUP.md, part 6). */
export function adminConsentRedirectUri(
  publicOrigin: string,
  path: string = ADMIN_CONSENT_CALLBACK_PATH,
): string {
  const origin = new URL(publicOrigin).origin;
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

export interface AdminConsentUrlInput {
  /** Client id of the backup app registration (ENTRA_CLIENT_ID). */
  clientId: string;
  /** Tenant id or verified domain of the customer; omitted → `organizations`. */
  tenant?: string | null;
  redirectUri: string;
  /** Signed state from {@link signConsentState}. */
  state: string;
  authorityHost?: string;
  scope?: string;
}

/** Build the admin-consent URL the customer admin opens. */
export function buildAdminConsentUrl(input: AdminConsentUrlInput): string {
  const authority = (input.authorityHost ?? DEFAULT_AUTHORITY_HOST).replace(/\/+$/, "");
  const audience = normalizeTenantReference(input.tenant) ?? DEFAULT_CONSENT_AUDIENCE;
  const url = new URL(`${authority}/${encodeURIComponent(audience)}/v2.0/adminconsent`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", input.scope ?? GRAPH_DEFAULT_SCOPE);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export type AdminConsentCallback =
  | {
      ok: true;
      /**
       * Entra tenant id (GUID) the redirect claims consented. Unsigned and
       * forgeable: never bind anything to it before it is proven.
       */
      claimedTenantId: string;
      state: string;
      scope: string | null;
    }
  | {
      ok: false;
      /** Entra error code, e.g. `access_denied`, or `consent_not_granted`. */
      error: string;
      errorDescription: string | null;
      state: string | null;
    };

/**
 * Interpret the query string Entra sends to the callback. Success needs
 * `admin_consent=True` *and* a tenant id; the admin declining shows up as
 * `error=access_denied`.
 */
export function parseAdminConsentCallback(
  query: URLSearchParams | Record<string, string | undefined>,
): AdminConsentCallback {
  const params = toSearchParams(query);
  const state = params.get("state");
  const error = params.get("error");
  if (error) {
    return { ok: false, error, errorDescription: params.get("error_description"), state };
  }
  const consented = (params.get("admin_consent") ?? "").toLowerCase() === "true";
  const tenantId = params.get("tenant")?.trim() ?? "";
  if (!consented || !isEntraTenantId(tenantId)) {
    return {
      ok: false,
      error: "consent_not_granted",
      errorDescription: params.get("error_description"),
      state,
    };
  }
  if (!state) {
    return { ok: false, error: "missing_state", errorDescription: null, state: null };
  }
  return { ok: true, claimedTenantId: tenantId.toLowerCase(), state, scope: params.get("scope") };
}

/** A callback query as URLSearchParams; undefined members of a record are dropped. */
export function toSearchParams(
  query: URLSearchParams | Record<string, string | undefined>,
): URLSearchParams {
  if (query instanceof URLSearchParams) {
    return query;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params;
}
