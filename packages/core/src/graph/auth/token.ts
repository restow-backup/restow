/**
 * Access tokens for the Graph backup app (client credentials, one token per
 * customer tenant).
 *
 * Restow's own small, dependency-free implementation of the OAuth 2.0
 * client-credentials grant against the Entra v2.0 token endpoint (no Microsoft
 * authentication library). It supports a client secret and the certificate flow
 * (RS256 client assertion, docs/ENTRA-SETUP.md, part 3), caches tokens until
 * shortly before they expire and coalesces concurrent refreshes. Another acquirer
 * can be wrapped through {@link CachingTokenProvider.fromAcquirer}; the client only
 * needs the {@link AccessTokenProvider} shape.
 *
 * Nothing in this module logs or throws secret material.
 */
import { createHash, createSign, randomUUID } from "node:crypto";
import { isTransientTransferError } from "../../storage/transfer.js";

/** Anything that can hand out a valid bearer token for Graph. */
export interface AccessTokenProvider {
  getToken(): Promise<string>;
}

/** A freshly acquired token together with its absolute expiry. */
export interface AcquiredToken {
  accessToken: string;
  /** Absolute expiry in epoch milliseconds. */
  expiresAtMs: number;
}

/** Default login host for the public Entra cloud. */
export const DEFAULT_AUTHORITY_HOST = "https://login.microsoftonline.com";
/** The application scope for client-credentials tokens against Graph. */
export const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
/** Refresh this long before the token actually expires. */
export const DEFAULT_EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** A token younger than this is not replaced after a refusal (see `refreshAfterRefusal`). */
export const TOKEN_REFRESH_MIN_AGE_MS = 60 * 1000;

/**
 * Login hosts Restow accepts as an Entra authority: the public cloud and the
 * three sovereign clouds. A saved or configured authority host reaches
 * customer admin-consent links, the consent proof's issuer check and every
 * outbound token request (worker and API), so it must never be an arbitrary
 * origin: that would let a stored value be pointed at an internal host (SSRF)
 * or at a look-alike login host (phishing, forged consent proof).
 */
export const ENTRA_AUTHORITY_HOSTS: readonly string[] = [
  DEFAULT_AUTHORITY_HOST,
  "https://login.microsoftonline.us",
  "https://login.chinacloudapi.cn",
  "https://login.partner.microsoftonline.cn",
];

/** True when `origin` (no path, query or hash) is one of {@link ENTRA_AUTHORITY_HOSTS}. */
export function isAllowedAuthorityHost(origin: string): boolean {
  return ENTRA_AUTHORITY_HOSTS.includes(origin);
}

export type ClientCredential =
  | { type: "secret"; clientSecret: string }
  | {
      type: "certificate";
      /** PKCS#8 or PKCS#1 private key in PEM form. */
      privateKeyPem: string;
      /** The public certificate in PEM form (used to derive the x5t thumbprint) ... */
      certificatePem?: string;
      /** ... or the SHA-1 thumbprint as hex, exactly as Entra shows it. */
      thumbprintSha1Hex?: string;
    };

/** Credentials of the backup app registration (shared by all tenants). */
export interface AppCredentials {
  clientId: string;
  credential: ClientCredential;
  /** Override for sovereign clouds, e.g. `https://login.microsoftonline.us`. */
  authorityHost?: string;
  scope?: string;
}

/**
 * The token endpoint could not be reached at all (DNS, connect, reset, timeout), even after
 * a few quick attempts. Deliberately neither a TypeError nor an error with a transport `code`:
 * without a token every following Graph call fails as well, so the engines must fail the run
 * (and resume it later from its checkpoint) instead of recording each item as failed
 * (`isItemLevelError`). The network error stays as `cause`, so the failure classifier still
 * reports the actual network cause.
 */
export class TokenEndpointUnreachableError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`The token endpoint could not be reached${detail}`, { cause });
    this.name = "TokenEndpointUnreachableError";
  }
}

/** Waits before a token request is sent again after a network error (two retries). */
export const TOKEN_NETWORK_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];
/** How long one token request may take before it counts as a network error. */
export const TOKEN_REQUEST_TIMEOUT_MS = 60_000;

export class TokenAcquisitionError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly correlationId: string | undefined;

  constructor(
    message: string,
    details: { status?: number; code?: string; correlationId?: string },
  ) {
    super(message);
    this.name = "TokenAcquisitionError";
    this.status = details.status;
    this.code = details.code;
    this.correlationId = details.correlationId;
  }
}

/** Caches an acquired token and coalesces concurrent refreshes. */
export class CachingTokenProvider implements AccessTokenProvider {
  private cached: AcquiredToken | null = null;
  /** When the cached token was fetched, in epoch milliseconds. */
  private cachedAtMs = 0;
  private inFlight: Promise<AcquiredToken> | null = null;

  constructor(
    private readonly acquire: () => Promise<AcquiredToken>,
    private readonly options: { expirySkewMs?: number; now?: () => number } = {},
  ) {}

  /** Wrap any acquirer (a function returning an {@link AcquiredToken}) in the cache. */
  static fromAcquirer(
    acquire: () => Promise<AcquiredToken>,
    options?: { expirySkewMs?: number; now?: () => number },
  ): CachingTokenProvider {
    return new CachingTokenProvider(acquire, options);
  }

  async getToken(): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    const skew = this.options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS;
    if (this.cached && this.cached.expiresAtMs - skew > now) {
      return this.cached.accessToken;
    }
    if (!this.inFlight) {
      this.inFlight = this.acquire().finally(() => {
        this.inFlight = null;
      });
    }
    const token = await this.inFlight;
    if (this.cached !== token) {
      this.cached = token;
      this.cachedAtMs = this.options.now?.() ?? Date.now();
    }
    return token.accessToken;
  }

  /** Drop the cached token, e.g. after Graph answered 401 with an expired token. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Drop the cached token after Graph refused it (401 or 403), unless it was fetched less than
   * `minAgeMs` ago. A token carries the app's permissions as they were when it was issued, so
   * a permission an administrator granted since then only arrives with a new one. The minimum
   * age keeps a run of refusals (an item the app may not read) from fetching a token each time.
   * True when the next {@link getToken} hands out a different token than the refused one.
   *
   * `refusedToken` is the token the refused request was sent with. Requests run concurrently:
   * when several were sent with the same old token, the first refusal drops it and the others
   * land while the new one is being fetched (nothing cached) or once it arrived (cached, but
   * younger than `minAgeMs`). Both mean the refused token is already gone, so they are told to
   * send again too, without fetching another token. Without `refusedToken` (older callers)
   * only the cached token's age decides.
   */
  refreshAfterRefusal(refusedToken?: string, minAgeMs = TOKEN_REFRESH_MIN_AGE_MS): boolean {
    if (refusedToken !== undefined && this.cached?.accessToken !== refusedToken) {
      // Already replaced, being replaced or dropped: the next getToken is not the refused one.
      return true;
    }
    if (!this.cached) {
      return false;
    }
    const now = this.options.now?.() ?? Date.now();
    const ageMs = now - this.cachedAtMs;
    // A negative age means the wall clock stepped back (NTP correction, VM resume) since the
    // token was cached; its real age is unknown, so it does not hold back the refresh.
    if (ageMs >= 0 && ageMs < minAgeMs) {
      return false;
    }
    this.cached = null;
    return true;
  }
}

export interface ClientCredentialsOptions {
  tenantId: string;
  app: AppCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
  expirySkewMs?: number;
  /** Waits between attempts after a network error (default {@link TOKEN_NETWORK_RETRY_DELAYS_MS}). */
  networkRetryDelaysMs?: readonly number[];
  /** Injectable sleep for those waits (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** Token endpoint of the v2.0 authority for a tenant. */
export function tokenEndpointFor(tenantId: string, authorityHost = DEFAULT_AUTHORITY_HOST): string {
  return `${authorityHost.replace(/\/+$/, "")}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

/**
 * Client-credentials provider for exactly one customer tenant. Create one per
 * tenant (see {@link TenantTokenProviders}) — tokens are tenant-bound.
 */
export class ClientCredentialsTokenProvider extends CachingTokenProvider {
  readonly tenantId: string;

  constructor(options: ClientCredentialsOptions) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? Date.now;
    const endpoint = tokenEndpointFor(options.tenantId, options.app.authorityHost);
    const retryDelaysMs = options.networkRetryDelaysMs ?? TOKEN_NETWORK_RETRY_DELAYS_MS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const acquire = async (): Promise<AcquiredToken> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await requestClientCredentialsToken({
            endpoint,
            app: options.app,
            fetchImpl,
            now,
          });
        } catch (error) {
          if (error instanceof TokenAcquisitionError) {
            throw error; // Entra answered: retrying the same request changes nothing.
          }
          if (!isTransientTransferError(error) && !isFetchFailure(error)) {
            throw error;
          }
          const delay = retryDelaysMs[attempt];
          if (delay === undefined) {
            throw new TokenEndpointUnreachableError(error);
          }
          // A short network blip (reset, DNS hiccup) must not fail a whole run: try again.
          await sleep(delay);
        }
      }
    };
    super(acquire, {
      expirySkewMs: options.expirySkewMs,
      now,
    });
    this.tenantId = options.tenantId;
  }
}

/** Memoises one {@link ClientCredentialsTokenProvider} per customer tenant. */
export class TenantTokenProviders {
  private readonly providers = new Map<string, ClientCredentialsTokenProvider>();

  constructor(
    private readonly app: AppCredentials,
    private readonly options: Omit<ClientCredentialsOptions, "tenantId" | "app"> = {},
  ) {}

  forTenant(tenantId: string): ClientCredentialsTokenProvider {
    let provider = this.providers.get(tenantId);
    if (!provider) {
      provider = new ClientCredentialsTokenProvider({ tenantId, app: this.app, ...this.options });
      this.providers.set(tenantId, provider);
    }
    return provider;
  }

  /** Forget a tenant (after disconnect) so its token is not kept in memory. */
  forget(tenantId: string): void {
    this.providers.delete(tenantId);
  }
}

/**
 * undici rejects with `TypeError("fetch failed")` when no response arrived; its cause names the
 * socket or DNS error, but not always with a code the transfer classifier knows (ENOTFOUND).
 */
function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

interface TokenEndpointSuccess {
  token_type?: string;
  expires_in?: number | string;
  access_token?: string;
}

interface TokenEndpointFailure {
  error?: string;
  error_description?: string;
  correlation_id?: string;
}

async function requestClientCredentialsToken(input: {
  endpoint: string;
  app: AppCredentials;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<AcquiredToken> {
  const params = new URLSearchParams();
  params.set("client_id", input.app.clientId);
  params.set("grant_type", "client_credentials");
  params.set("scope", input.app.scope ?? GRAPH_DEFAULT_SCOPE);
  const credential = input.app.credential;
  if (credential.type === "secret") {
    params.set("client_secret", credential.clientSecret);
  } else {
    params.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    params.set(
      "client_assertion",
      buildClientAssertion({
        clientId: input.app.clientId,
        audience: input.endpoint,
        credential,
        nowMs: input.now(),
      }),
    );
  }

  // A redirect would re-send the client secret or assertion to its target. The timeout keeps a
  // hanging endpoint from holding every Graph call that waits for this token.
  const response = await input.fetchImpl(input.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: TokenEndpointSuccess & TokenEndpointFailure = {};
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }

  if (!response.ok || typeof payload.access_token !== "string") {
    // error_description from Entra never contains the secret; it names the cause
    // (AADSTS7000215 invalid secret, AADSTS700016 app not found in tenant, ...).
    const code = payload.error ? ` (${payload.error})` : "";
    const detail = payload.error_description ? `: ${payload.error_description}` : "";
    throw new TokenAcquisitionError(
      `Token request failed with ${response.status}${code}${detail}`,
      {
        status: response.status,
        code: payload.error,
        correlationId: payload.correlation_id,
      },
    );
  }
  const expiresIn = Number(payload.expires_in ?? 3600);
  return {
    accessToken: payload.access_token,
    expiresAtMs: input.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  };
}

/** Base64url without padding, as JOSE requires. */
export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Extract the DER bytes of the first PEM block in `pem`. */
export function derFromPem(pem: string): Buffer {
  const match = pem.match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/);
  if (!match?.[1]) {
    throw new Error("Expected a PEM block");
  }
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

/** SHA-1 thumbprint of a PEM certificate, hex encoded (as shown in the Entra portal). */
export function certificateThumbprintSha1Hex(certificatePem: string): string {
  return createHash("sha1").update(derFromPem(certificatePem)).digest("hex");
}

/**
 * Build the RS256 client assertion JWT for the certificate flow:
 * header `{ alg, typ, x5t }`, claims `{ aud, iss, sub, jti, nbf, exp }`.
 */
export function buildClientAssertion(input: {
  clientId: string;
  audience: string;
  credential: Extract<ClientCredential, { type: "certificate" }>;
  nowMs: number;
  lifetimeSeconds?: number;
}): string {
  const thumbprintHex =
    input.credential.thumbprintSha1Hex?.replace(/[^0-9a-f]/gi, "").toLowerCase() ??
    (input.credential.certificatePem
      ? certificateThumbprintSha1Hex(input.credential.certificatePem)
      : undefined);
  if (!thumbprintHex) {
    throw new Error("Certificate credential needs certificatePem or thumbprintSha1Hex");
  }
  const nowSeconds = Math.floor(input.nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT", x5t: base64url(Buffer.from(thumbprintHex, "hex")) };
  const claims = {
    aud: input.audience,
    iss: input.clientId,
    sub: input.clientId,
    jti: randomUUID(),
    nbf: nowSeconds,
    exp: nowSeconds + (input.lifetimeSeconds ?? 10 * 60),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(input.credential.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

/** A fixed token, for tests and for the standalone tools that receive one from outside. */
export class StaticTokenProvider implements AccessTokenProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
}

/** Adapt a provider to the `accessTokenProvider` callback the Graph client takes. */
export function toTokenCallback(provider: AccessTokenProvider): () => Promise<string> {
  return () => provider.getToken();
}

/** The callback a Graph client calls after a 401 or 403 (`GraphClientOptions.refreshAccessToken`). */
export function toRefreshCallback(
  provider: CachingTokenProvider,
): (refusedToken?: string) => boolean {
  return (refusedToken) => provider.refreshAfterRefusal(refusedToken);
}
