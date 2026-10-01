/**
 * Proof of who granted an admin consent (docs/ENTRA-SETUP.md, part 4).
 *
 * The admin-consent redirect names a tenant, but Microsoft does not sign that
 * parameter. Binding a source to the claim would let anyone holding a consent
 * link attach any organisation that already consented to the shared,
 * multi-tenant backup app, and pull its mailboxes into their own Restow
 * tenant. So after the consent the admin signs in once more through OpenID
 * Connect (authorization code flow) against the claimed tenant, and only what
 * that sign-in proves counts:
 *
 *   1. the code is redeemed at the claimed tenant's token endpoint with the
 *      backup app's own credentials;
 *   2. the id_token must name that tenant (`tid`, `iss`), this app (`aud`)
 *      and the nonce from the signed state;
 *   3. the signed-in account must hold a directory role that may grant
 *      tenant-wide consent to Graph application permissions. Any member or
 *      guest can sign in to a tenant; only these roles speak for it.
 *
 * The id_token's signature is not verified: it arrives directly from the
 * token endpoint over TLS in exchange for our client credentials, which OIDC
 * Core 1.0 §3.1.3.7 accepts in place of a signature check.
 */
import {
  type AppCredentials,
  DEFAULT_AUTHORITY_HOST,
  buildClientAssertion,
  tokenEndpointFor,
} from "../graph/auth/token.js";
import type { GraphClient } from "../graph/client.js";
import { isEntraTenantId, toSearchParams } from "./consent.js";
import { decodeJwtClaims } from "./permissions.js";

/** Scopes of the proof sign-in: identity only, no data access. */
export const CONSENT_SIGN_IN_SCOPE = "openid profile";

/** Directory role template ids (identical in every tenant). */
export const GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID = "62e90394-69f5-4237-9190-012177145e10";
export const PRIVILEGED_ROLE_ADMINISTRATOR_ROLE_TEMPLATE_ID =
  "e8611ab8-c189-46e8-94e1-60213ab1f814";

/**
 * The roles that may grant tenant-wide admin consent to Microsoft Graph
 * application permissions. Cloud Application and Application Administrators
 * may consent to other APIs, but not to Graph app roles, so they are not
 * enough for the permissions Restow needs.
 */
export const CONSENT_AUTHORITY_ROLE_TEMPLATE_IDS: readonly string[] = [
  GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID,
  PRIVILEGED_ROLE_ADMINISTRATOR_ROLE_TEMPLATE_ID,
];

/** True when one of the role template ids may grant the consent Restow needs. */
export function holdsConsentAuthority(roleTemplateIds: readonly string[]): boolean {
  const held = new Set(roleTemplateIds.map((id) => id.toLowerCase()));
  return CONSENT_AUTHORITY_ROLE_TEMPLATE_IDS.some((id) => held.has(id));
}

function authorityBase(authorityHost: string | undefined): string {
  return (authorityHost ?? DEFAULT_AUTHORITY_HOST).replace(/\/+$/, "");
}

// --- Sign-in URL and callback ------------------------------------------------------

export interface ConsentSignInUrlInput {
  /** Client id of the backup app (ENTRA_CLIENT_ID). */
  clientId: string;
  /** The Entra tenant (GUID) to prove; the sign-in happens in this tenant only. */
  tenantId: string;
  /** The same redirect URI as the admin-consent link. */
  redirectUri: string;
  /** Signed sign-in state (phase `signin`). */
  state: string;
  /** The nonce from that state; the id_token must echo it. */
  nonce: string;
  authorityHost?: string;
}

/** The authorization request of the proof sign-in. */
export function buildConsentSignInUrl(input: ConsentSignInUrlInput): string {
  if (!isEntraTenantId(input.tenantId)) {
    throw new Error("the proof sign-in needs a tenant id (GUID)");
  }
  const url = new URL(
    `${authorityBase(input.authorityHost)}/${input.tenantId.toLowerCase()}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CONSENT_SIGN_IN_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  return url.toString();
}

export type ConsentSignInCallback =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string; errorDescription: string | null; state: string | null };

/** Interpret the redirect of the proof sign-in: an authorization code, or Entra's error. */
export function parseConsentSignInCallback(
  query: URLSearchParams | Record<string, string | undefined>,
): ConsentSignInCallback {
  const params = toSearchParams(query);
  const state = params.get("state");
  const error = params.get("error");
  if (error) {
    return { ok: false, error, errorDescription: params.get("error_description"), state };
  }
  const code = params.get("code");
  if (!code) {
    return { ok: false, error: "missing_code", errorDescription: null, state };
  }
  if (!state) {
    return { ok: false, error: "missing_state", errorDescription: null, state: null };
  }
  return { ok: true, code, state };
}

// --- Code redemption -----------------------------------------------------------------

export interface RedeemConsentSignInCodeInput {
  app: AppCredentials;
  /** The tenant whose token endpoint redeems the code (the claimed tenant). */
  tenantId: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type CodeRedemption =
  | { ok: true; idToken: string }
  | { ok: false; error: string; description: string | null; status: number | null };

interface TokenEndpointBody {
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** Client authentication for the token endpoint: secret or certificate assertion. */
function clientAuthentication(
  app: AppCredentials,
  endpoint: string,
  nowMs: number,
): Record<string, string> {
  const credential = app.credential;
  if (credential.type === "secret") {
    return { client_secret: credential.clientSecret };
  }
  return {
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: buildClientAssertion({
      clientId: app.clientId,
      audience: endpoint,
      credential,
      nowMs,
    }),
  };
}

/** Redeem the authorization code for the id_token. Never throws for Entra's answers. */
export async function redeemConsentSignInCode(
  input: RedeemConsentSignInCodeInput,
): Promise<CodeRedemption> {
  const endpoint = tokenEndpointFor(input.tenantId, input.app.authorityHost);
  const params = new URLSearchParams({
    client_id: input.app.clientId,
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    scope: CONSENT_SIGN_IN_SCOPE,
    ...clientAuthentication(input.app, endpoint, input.now?.() ?? Date.now()),
  });

  let response: Response;
  try {
    // A redirect would re-send the client credentials and the code to its target.
    response = await (input.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
      redirect: "error",
    });
  } catch (error) {
    return {
      ok: false,
      error: "token_endpoint_unreachable",
      description: error instanceof Error ? error.message : String(error),
      status: null,
    };
  }

  let body: TokenEndpointBody = {};
  try {
    body = (await response.json()) as TokenEndpointBody;
  } catch {
    body = {};
  }
  if (response.ok && typeof body.id_token === "string" && body.id_token.length > 0) {
    return { ok: true, idToken: body.id_token };
  }
  return {
    ok: false,
    error: typeof body.error === "string" ? body.error : "no_id_token",
    description: typeof body.error_description === "string" ? body.error_description : null,
    status: response.status,
  };
}

// --- id_token ------------------------------------------------------------------------------

/** The account the proof sign-in established. */
export interface ConsentingAdmin {
  /** The Entra tenant (`tid`), lower-cased. */
  tenantId: string;
  /** Object id (`oid`) of the account in that tenant. */
  objectId: string;
  /** `preferred_username` (usually the UPN), when the token carries it. */
  username: string | null;
  name: string | null;
  /** Directory role template ids from the `wids` claim; null when the token carries none. */
  roleTemplateIds: string[] | null;
}

export type IdTokenFailure =
  | "malformed"
  | "audience"
  | "issuer"
  | "tenant"
  | "nonce"
  | "lifetime"
  | "subject";

export interface IdTokenExpectation {
  clientId: string;
  /** The claimed Entra tenant (GUID) the token must be issued for. */
  tenantId: string;
  nonce: string;
  authorityHost?: string;
  nowMs?: number;
  /** Tolerated clock difference to Entra (default five minutes). */
  clockSkewMs?: number;
}

export type IdTokenValidation =
  | { ok: true; admin: ConsentingAdmin }
  | { ok: false; reason: IdTokenFailure };

const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

function stringClaim(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function audienceMatches(aud: unknown, clientId: string): boolean {
  const wanted = clientId.toLowerCase();
  if (typeof aud === "string") {
    return aud.toLowerCase() === wanted;
  }
  return Array.isArray(aud) && aud.some((entry) => String(entry).toLowerCase() === wanted);
}

/** Check the id_token of the proof sign-in against what the signed state expects. */
export function validateConsentIdToken(
  idToken: string,
  expected: IdTokenExpectation,
): IdTokenValidation {
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtClaims(idToken);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const tenantId = expected.tenantId.toLowerCase();
  if (!audienceMatches(claims.aud, expected.clientId)) {
    return { ok: false, reason: "audience" };
  }
  if (stringClaim(claims, "tid")?.toLowerCase() !== tenantId) {
    return { ok: false, reason: "tenant" };
  }
  const issuer = `${authorityBase(expected.authorityHost)}/${tenantId}/v2.0`;
  if (stringClaim(claims, "iss")?.toLowerCase() !== issuer.toLowerCase()) {
    return { ok: false, reason: "issuer" };
  }
  if (stringClaim(claims, "nonce") !== expected.nonce) {
    return { ok: false, reason: "nonce" };
  }
  const now = expected.nowMs ?? Date.now();
  const skew = expected.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const exp = typeof claims.exp === "number" ? claims.exp * 1000 : null;
  const nbf = typeof claims.nbf === "number" ? claims.nbf * 1000 : null;
  if (exp === null || exp + skew <= now || (nbf !== null && nbf - skew > now)) {
    return { ok: false, reason: "lifetime" };
  }
  const objectId = stringClaim(claims, "oid");
  if (!objectId || !isEntraTenantId(objectId)) {
    return { ok: false, reason: "subject" };
  }
  const wids = Array.isArray(claims.wids)
    ? claims.wids.filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase())
    : null;
  return {
    ok: true,
    admin: {
      tenantId,
      objectId: objectId.toLowerCase(),
      username: stringClaim(claims, "preferred_username"),
      name: stringClaim(claims, "name"),
      roleTemplateIds: wids,
    },
  };
}

// --- Directory roles -----------------------------------------------------------------------

export type RoleLookup =
  | { ok: true; roleTemplateIds: string[] }
  | { ok: false; status: number | null; code: string | null; message: string };

interface MembershipPage {
  value?: Array<{ "@odata.type"?: unknown; roleTemplateId?: unknown }>;
  "@odata.nextLink"?: unknown;
  error?: { code?: string; message?: string };
}

const DIRECTORY_ROLE_TYPE = "#microsoft.graph.directoryRole";

/** Pages of memberships read at most; an admin in more groups than this is unheard of. */
const MAX_MEMBERSHIP_PAGES = 20;

/**
 * The directory roles an account holds, directly or through role-assignable
 * groups, read with the app-only token (`Directory.Read.All`). Activated
 * roles only: a PIM-eligible role that is not active did not grant anything.
 */
export async function lookupDirectoryRoleTemplateIds(
  graph: GraphClient,
  objectId: string,
): Promise<RoleLookup> {
  const roles = new Set<string>();
  let url: string | null = `/users/${encodeURIComponent(objectId)}/transitiveMemberOf?$top=999`;
  try {
    for (let page = 0; url !== null && page < MAX_MEMBERSHIP_PAGES; page += 1) {
      const response: { status: number; body: MembershipPage | string } = await graph.request<
        MembershipPage | string
      >({ method: "GET", url });
      const body = typeof response.body === "object" && response.body !== null ? response.body : {};
      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          status: response.status,
          code: body.error?.code ?? null,
          message: body.error?.message ?? `HTTP ${response.status}`,
        };
      }
      for (const entry of body.value ?? []) {
        if (
          entry["@odata.type"] === DIRECTORY_ROLE_TYPE &&
          typeof entry.roleTemplateId === "string"
        ) {
          roles.add(entry.roleTemplateId.toLowerCase());
        }
      }
      url = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : null;
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      code: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, roleTemplateIds: [...roles] };
}

// --- The proof ----------------------------------------------------------------------------

/**
 * Why a consent could not be attributed to an admin of the claimed tenant.
 *
 *   sign_in_failed    — the admin cancelled the sign-in, or the code could not be redeemed;
 *   identity_mismatch — the id_token does not match the claim (other tenant, app or nonce);
 *   not_an_admin      — signed in, but without a role that may grant the consent;
 *   role_check_failed — the role could not be read (permissions not yet active, Graph down).
 */
export type ConsentIdentityFailure =
  | "sign_in_failed"
  | "identity_mismatch"
  | "not_an_admin"
  | "role_check_failed";

export type ConsentIdentityProof =
  | { ok: true; admin: ConsentingAdmin }
  | {
      ok: false;
      reason: ConsentIdentityFailure;
      /** Technical detail for the audit log and the operator (Entra/Graph message). */
      detail: string | null;
      /** The account that signed in, when the sign-in itself succeeded. */
      account: Pick<ConsentingAdmin, "objectId" | "username"> | null;
    };

/**
 * Right after a consent Microsoft can take a few seconds before app-only
 * tokens for the tenant carry the new permissions; the role lookup waits
 * this long in total before giving up.
 */
export const DEFAULT_ROLE_LOOKUP_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000];

export interface ProveConsentingAdminInput {
  app: AppCredentials;
  /** The claimed Entra tenant from the signed sign-in state. */
  tenantId: string;
  code: string;
  redirectUri: string;
  /** The nonce from the signed sign-in state. */
  nonce: string;
  /** App-only Graph client for that tenant (role lookup when the token has no `wids`). */
  graph: GraphClient;
  /** Called before the role lookup is retried, e.g. to drop a cached token without roles. */
  onRoleLookupRetry?: () => void;
  roleLookupRetryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lookupWithRetries(input: ProveConsentingAdminInput, objectId: string) {
  const delays = input.roleLookupRetryDelaysMs ?? DEFAULT_ROLE_LOOKUP_RETRY_DELAYS_MS;
  const sleep = input.sleep ?? sleepFor;
  let lookup = await lookupDirectoryRoleTemplateIds(input.graph, objectId);
  for (const delay of delays) {
    if (lookup.ok) {
      break;
    }
    await sleep(delay);
    input.onRoleLookupRetry?.();
    lookup = await lookupDirectoryRoleTemplateIds(input.graph, objectId);
  }
  return lookup;
}

/** Redeem the code, check the id_token and the account's role: the whole proof. */
export async function proveConsentingAdmin(
  input: ProveConsentingAdminInput,
): Promise<ConsentIdentityProof> {
  const redemption = await redeemConsentSignInCode({
    app: input.app,
    tenantId: input.tenantId,
    code: input.code,
    redirectUri: input.redirectUri,
    fetchImpl: input.fetchImpl,
    now: input.now,
  });
  if (!redemption.ok) {
    const detail = redemption.description
      ? `${redemption.error}: ${redemption.description}`
      : redemption.error;
    return { ok: false, reason: "sign_in_failed", detail, account: null };
  }

  const token = validateConsentIdToken(redemption.idToken, {
    clientId: input.app.clientId,
    tenantId: input.tenantId,
    nonce: input.nonce,
    authorityHost: input.app.authorityHost,
    nowMs: input.now?.(),
  });
  if (!token.ok) {
    return { ok: false, reason: "identity_mismatch", detail: token.reason, account: null };
  }
  const admin = token.admin;
  const account = { objectId: admin.objectId, username: admin.username };

  // `wids` is only emitted when the app registration asks for it; a positive
  // answer settles it, anything else is confirmed against the directory.
  if (admin.roleTemplateIds && holdsConsentAuthority(admin.roleTemplateIds)) {
    return { ok: true, admin };
  }
  const lookup = await lookupWithRetries(input, admin.objectId);
  if (!lookup.ok) {
    const code = lookup.code ?? (lookup.status === null ? "error" : `HTTP ${lookup.status}`);
    return {
      ok: false,
      reason: "role_check_failed",
      detail: `${code}: ${lookup.message}`,
      account,
    };
  }
  if (!holdsConsentAuthority(lookup.roleTemplateIds)) {
    return { ok: false, reason: "not_an_admin", detail: null, account };
  }
  return { ok: true, admin: { ...admin, roleTemplateIds: lookup.roleTemplateIds } };
}
