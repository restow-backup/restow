/**
 * Access tokens for the Graph backup app (client credentials, one token per
 * customer tenant).
 *
 * `@azure/msal-node` is only installed in apps/api, so core keeps its own small,
 * dependency-free implementation of the OAuth 2.0 client-credentials grant against
 * the Entra v2.0 token endpoint. It supports a client secret and the certificate
 * flow (RS256 client assertion, docs/ENTRA-SETUP.md, part 3), caches tokens until
 * shortly before they expire and coalesces concurrent refreshes. apps/api may wrap
 * msal instead through {@link CachingTokenProvider.fromAcquirer}; the client only
 * needs the {@link AccessTokenProvider} shape.
 *
 * Nothing in this module logs or throws secret material.
 */
import { createHash, createSign, randomUUID } from "node:crypto";

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
  private inFlight: Promise<AcquiredToken> | null = null;

  constructor(
    private readonly acquire: () => Promise<AcquiredToken>,
    private readonly options: { expirySkewMs?: number; now?: () => number } = {},
  ) {}

  /** Wrap any acquirer (for example msal's acquireTokenByClientCredential) in the cache. */
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
    this.cached = token;
    return token.accessToken;
  }

  /** Drop the cached token, e.g. after Graph answered 401 with an expired token. */
  invalidate(): void {
    this.cached = null;
  }
}

export interface ClientCredentialsOptions {
  tenantId: string;
  app: AppCredentials;
  fetchImpl?: typeof fetch;
  now?: () => number;
  expirySkewMs?: number;
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
    super(() => requestClientCredentialsToken({ endpoint, app: options.app, fetchImpl, now }), {
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

  // A redirect would re-send the client secret or assertion to its target.
  const response = await input.fetchImpl(input.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
    redirect: "error",
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
  if (!match || !match[1]) {
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
