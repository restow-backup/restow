import {
  ClientCredentialsTokenProvider,
  GRAPH_DEFAULT_SCOPE,
  TokenAcquisitionError,
} from "../graph/auth/token.js";
import type { EntraAppSource, EntraCredentialKind, ResolvedEntraApp } from "./app-registration.js";
import { type PermissionDiff, diffPermissions, rolesFromAccessToken } from "./permissions.js";

/**
 * "Test connection" for the backup app registration itself, before any
 * customer tenant is connected: acquire a client-credentials token for
 * Microsoft Graph in the app's own directory (docs/ENTRA-SETUP.md, part 2 and
 * 3) and compare the `roles` claim with the application permissions Restow
 * needs. Entra's refusals are mapped to stable reasons the UI explains in the
 * operator's language; the AADSTS code stays visible for support.
 *
 * Nothing is persisted here and no credential material leaves this module:
 * Entra's own error description is passed on with the secret redacted.
 */

/** Why the test did not come back green. */
export type AppTestFailureReason =
  /** AADSTS7000215: typically the secret's ID was entered instead of its value. */
  | "invalid_secret"
  /** AADSTS7000222: the client secret has expired. */
  | "secret_expired"
  /** AADSTS700016: no app with this client id in that directory. */
  | "app_not_found"
  /** AADSTS90002, AADSTS900023: the directory (tenant) does not exist or is malformed. */
  | "tenant_not_found"
  /** AADSTS7000218: Entra expected a secret or certificate and accepted none. */
  | "credential_missing"
  /** AADSTS700027: the certificate is not registered on the app (or its signature fails). */
  | "invalid_certificate"
  /** AADSTS65001, or a token without a single application permission: no admin consent. */
  | "consent_missing"
  /** Token acquired, but required application permissions are missing. */
  | "permissions_missing"
  /** Entra could not be reached (DNS, TLS, timeout). */
  | "network"
  /** Any other refusal; the AADSTS code is shown. */
  | "other";

export interface AppTestResult {
  ok: boolean;
  /** ISO 8601. */
  checkedAt: string;
  durationMs: number;
  /** The directory the token was requested in. */
  tenantId: string;
  clientId: string;
  source: EntraAppSource;
  credentialKind: EntraCredentialKind;
  tokenAcquired: boolean;
  reason: AppTestFailureReason | null;
  /** AADSTS code (e.g. `AADSTS7000215`) when Entra named one. */
  aadsts: string | null;
  /** Entra's own description (credential redacted, length bounded); null on success. */
  detail: string | null;
  /** Granted, missing and unexpected permissions; null without a token. */
  permissions: PermissionDiff | null;
}

/** Longest wait for the token endpoint before the test reports a network problem. */
export const APP_TEST_TIMEOUT_MS = 20_000;

const MAX_DETAIL_LENGTH = 500;

const AADSTS_REASONS: Record<string, AppTestFailureReason> = {
  AADSTS7000215: "invalid_secret",
  AADSTS7000222: "secret_expired",
  AADSTS700016: "app_not_found",
  AADSTS90002: "tenant_not_found",
  AADSTS900023: "tenant_not_found",
  AADSTS7000218: "credential_missing",
  AADSTS700027: "invalid_certificate",
  AADSTS65001: "consent_missing",
};

/** Remove the credential from a message (defence in depth) and bound its length. */
export function redactDetail(
  message: string | null | undefined,
  secrets: readonly string[],
): string | null {
  if (!message) {
    return null;
  }
  let redacted = message;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  const trimmed = redacted.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed;
}

function networkDetail(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "The token endpoint did not answer in time.";
    }
    const cause = (error as { cause?: unknown }).cause;
    const code =
      cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
    return typeof code === "string" ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

/** Map a failed token request onto a reason; `detail` is still unredacted. */
export function classifyAppTestFailure(error: unknown): {
  reason: AppTestFailureReason;
  aadsts: string | null;
  detail: string | null;
} {
  if (error instanceof TokenAcquisitionError) {
    const aadsts = /AADSTS\d+/.exec(error.message)?.[0] ?? null;
    const reason = (aadsts ? AADSTS_REASONS[aadsts] : undefined) ?? "other";
    return { reason, aadsts, detail: error.message };
  }
  return { reason: "network", aadsts: null, detail: networkDetail(error) };
}

/** A fetch that gives up after `timeoutMs`. */
function withTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })) as typeof fetch;
}

export interface TestAppRegistrationInput {
  app: ResolvedEntraApp;
  /** Directory (tenant) ID or verified domain to request the token in. */
  tenantId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Run the test; never throws, every outcome is a result. */
export async function testAppRegistration(input: TestAppRegistrationInput): Promise<AppTestResult> {
  const now = input.now ?? (() => new Date());
  const started = now();
  const { app } = input;
  const credential = app.credentials.credential;
  const secrets =
    credential.type === "secret" ? [credential.clientSecret] : [credential.privateKeyPem];
  const finish = (
    outcome: Pick<AppTestResult, "tokenAcquired" | "reason" | "aadsts" | "detail" | "permissions">,
  ): AppTestResult => ({
    ok: outcome.reason === null,
    checkedAt: started.toISOString(),
    durationMs: Math.max(0, now().getTime() - started.getTime()),
    tenantId: input.tenantId,
    clientId: app.credentials.clientId,
    source: app.source,
    credentialKind: app.credentialKind,
    ...outcome,
  });

  const provider = new ClientCredentialsTokenProvider({
    tenantId: input.tenantId,
    app: { ...app.credentials, scope: GRAPH_DEFAULT_SCOPE },
    fetchImpl: withTimeout(input.fetchImpl ?? fetch, input.timeoutMs ?? APP_TEST_TIMEOUT_MS),
  });

  let token: string;
  try {
    token = await provider.getToken();
  } catch (error) {
    const failure = classifyAppTestFailure(error);
    return finish({
      tokenAcquired: false,
      reason: failure.reason,
      aadsts: failure.aadsts,
      detail: redactDetail(failure.detail, secrets),
      permissions: null,
    });
  }

  let roles: string[];
  try {
    roles = rolesFromAccessToken(token);
  } catch {
    // An opaque token carries no inspectable roles; it reads as "nothing granted".
    roles = [];
  }
  const permissions = diffPermissions(roles);
  const reason: AppTestFailureReason | null =
    roles.length === 0 ? "consent_missing" : permissions.complete ? null : "permissions_missing";
  return finish({ tokenAcquired: true, reason, aadsts: null, detail: null, permissions });
}
