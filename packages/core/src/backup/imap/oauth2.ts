/**
 * OAuth2 for IMAP (XOAUTH2 / OAUTHBEARER).
 *
 * The tenant secret store holds a JSON bundle per OAuth2 account: the refresh
 * token plus what is needed to exchange it. The engine exchanges it for a
 * short-lived access token right before connecting (docs/IMAP.md: Microsoft
 * 365 and Google with the operator's own OAuth app). Providers may rotate the
 * refresh token on every exchange; the rotated token is handed back to the
 * caller so the worker can persist it (core has no write access to secrets).
 */

export type ImapOAuth2Provider = "microsoft" | "google" | "custom";

/** Plaintext layout of an `oauth2` IMAP secret. */
export interface ImapOAuth2Secret {
  readonly provider: ImapOAuth2Provider;
  readonly refreshToken: string;
  readonly clientId: string;
  /** Confidential clients only; public clients (mobile/desktop apps) omit it. */
  readonly clientSecret?: string;
  /** Required for `custom`; derived for the known providers. */
  readonly tokenEndpoint?: string;
  /** Entra tenant id or domain for `microsoft`; defaults to `common`. */
  readonly tenantId?: string;
  /** Overrides the provider default scope. */
  readonly scope?: string;
}

export interface OAuth2AccessToken {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** A new refresh token when the provider rotated it, otherwise null. */
  readonly rotatedRefreshToken: string | null;
}

export class OAuth2Error extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "OAuth2Error";
  }
}

const MICROSOFT_IMAP_SCOPE = "https://outlook.office365.com/IMAP.AccessAsUser.All offline_access";
const GOOGLE_IMAP_SCOPE = "https://mail.google.com/";
const DEFAULT_TTL_MS = 55 * 60 * 1000;

export function microsoftTokenEndpoint(tenantId = "common"): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Parse and validate the JSON secret. Throws a message that never echoes secret values. */
export function parseOAuth2Secret(raw: string): ImapOAuth2Secret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OAuth2Error("oauth2 secret is not valid JSON", null, "invalid_secret");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new OAuth2Error("oauth2 secret must be a JSON object", null, "invalid_secret");
  }
  const value = parsed as Record<string, unknown>;
  const provider = value.provider;
  if (provider !== "microsoft" && provider !== "google" && provider !== "custom") {
    throw new OAuth2Error(
      "oauth2 secret: provider must be microsoft, google or custom",
      null,
      "invalid_secret",
    );
  }
  const refreshToken = nonEmptyString(value.refreshToken, "refreshToken");
  const clientId = nonEmptyString(value.clientId, "clientId");
  const clientSecret = optionalString(value.clientSecret, "clientSecret");
  const tokenEndpoint = optionalString(value.tokenEndpoint, "tokenEndpoint");
  const tenantId = optionalString(value.tenantId, "tenantId");
  const scope = optionalString(value.scope, "scope");
  if (provider === "custom" && !tokenEndpoint) {
    throw new OAuth2Error(
      "oauth2 secret: custom provider needs tokenEndpoint",
      null,
      "invalid_secret",
    );
  }
  return { provider, refreshToken, clientId, clientSecret, tokenEndpoint, tenantId, scope };
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OAuth2Error(`oauth2 secret: ${field} is required`, null, "invalid_secret");
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new OAuth2Error(`oauth2 secret: ${field} must be a string`, null, "invalid_secret");
  }
  return value.length > 0 ? value : undefined;
}

export function resolveTokenEndpoint(secret: ImapOAuth2Secret): string {
  switch (secret.provider) {
    case "microsoft":
      return secret.tokenEndpoint ?? microsoftTokenEndpoint(secret.tenantId);
    case "google":
      return secret.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
    case "custom":
      if (!secret.tokenEndpoint) {
        throw new OAuth2Error(
          "oauth2 secret: custom provider needs tokenEndpoint",
          null,
          "invalid_secret",
        );
      }
      return secret.tokenEndpoint;
  }
}

export function resolveScope(secret: ImapOAuth2Secret): string | undefined {
  if (secret.scope) {
    return secret.scope;
  }
  switch (secret.provider) {
    case "microsoft":
      return MICROSOFT_IMAP_SCOPE;
    case "google":
      return GOOGLE_IMAP_SCOPE;
    case "custom":
      return undefined;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** Exchange the refresh token for an access token (RFC 6749 section 6). */
export async function refreshAccessToken(
  secret: ImapOAuth2Secret,
  options: { readonly fetch?: FetchLike; readonly now?: () => number } = {},
): Promise<OAuth2AccessToken> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const now = options.now ?? Date.now;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: secret.refreshToken,
    client_id: secret.clientId,
  });
  if (secret.clientSecret) {
    body.set("client_secret", secret.clientSecret);
  }
  const scope = resolveScope(secret);
  if (scope) {
    body.set("scope", scope);
  }

  let response: Response;
  try {
    response = await fetchImpl(resolveTokenEndpoint(secret), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OAuth2Error(`token endpoint unreachable: ${detail}`, null, "network");
  }

  let payload: TokenResponse = {};
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    // A non-JSON body is reported through the status below.
  }
  if (!response.ok || typeof payload.access_token !== "string") {
    const code = typeof payload.error === "string" ? payload.error : null;
    const description =
      typeof payload.error_description === "string" ? payload.error_description : null;
    throw new OAuth2Error(
      `token refresh failed (${response.status}${code ? ` ${code}` : ""})${
        description ? `: ${description}` : ""
      }`,
      response.status,
      code,
    );
  }
  const ttlMs =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in * 1000
      : DEFAULT_TTL_MS;
  const rotated =
    typeof payload.refresh_token === "string" && payload.refresh_token !== secret.refreshToken
      ? payload.refresh_token
      : null;
  return {
    accessToken: payload.access_token,
    expiresAt: now() + ttlMs,
    rotatedRefreshToken: rotated,
  };
}
