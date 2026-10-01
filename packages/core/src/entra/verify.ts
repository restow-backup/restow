import type { AccessTokenProvider } from "../graph/auth/token.js";
import { TokenAcquisitionError } from "../graph/auth/token.js";
/**
 * "Verify permissions" for a connected Microsoft 365 tenant.
 *
 * Three steps, each reported honestly on its own:
 *   1. acquire a client-credentials token for the customer tenant (proves the
 *      app registration is known there and our credentials are valid);
 *   2. read the `roles` claim of that token and diff it against the required
 *      application permissions (the Mail.Read-instead-of-Mail.ReadWrite pitfall
 *      is called out by name);
 *   3. make one real Graph call — list the first users — so a policy or
 *      licensing problem shows up now, not during the first backup.
 *
 * Nothing here persists anything; the API layer stores the result on the source.
 */
import type { GraphClient } from "../graph/client.js";
import { type PermissionDiff, diffPermissions, rolesFromAccessToken } from "./permissions.js";

/** Why a token could not be acquired, in terms an operator can act on. */
export type TokenFailureHint =
  | "consent_missing"
  | "invalid_credentials"
  | "credentials_expired"
  | "tenant_unknown"
  | "unknown";

export interface TokenFailure {
  hint: TokenFailureHint;
  /** OAuth error code from Entra (`invalid_client`, `unauthorized_client`, ...). */
  code: string | null;
  /** The AADSTS code when present, e.g. `AADSTS700016`. */
  aadsts: string | null;
  status: number | null;
  /** Entra's description; never contains our secret. */
  message: string;
}

export interface UserSample {
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
}

export type TestCallResult =
  | { ok: true; usersSampled: number; sample: UserSample[] }
  | { ok: false; status: number | null; code: string | null; message: string };

export interface ConnectionVerification {
  /** ISO-8601 time of the check. */
  checkedAt: string;
  tokenAcquired: boolean;
  tokenError: TokenFailure | null;
  /** Null when no token could be acquired (nothing to diff). */
  permissions: PermissionDiff | null;
  /** Null when no token could be acquired. */
  testCall: TestCallResult | null;
  /** Token acquired, all required permissions granted and the test call answered 2xx. */
  ok: boolean;
}

/** A token provider that can be told to fetch a fresh token (the caching ones can). */
export interface RefreshableTokenProvider extends AccessTokenProvider {
  invalidate?(): void;
}

export interface VerifyTenantConnectionInput {
  tokenProvider: RefreshableTokenProvider;
  graph: GraphClient;
  /** How many users the test call asks for (1..999). */
  sampleSize?: number;
  now?: () => Date;
}

/** Properties the test call selects; deliberately minimal. */
export const TEST_CALL_SELECT = "id,displayName,userPrincipalName";

/** Map an Entra token error onto an actionable hint (AADSTS codes, docs/MICROSOFT.md). */
export function classifyTokenFailure(error: TokenAcquisitionError): TokenFailure {
  const aadsts = /AADSTS\d+/.exec(error.message)?.[0] ?? null;
  const code = error.code ?? null;
  let hint: TokenFailureHint = "unknown";
  switch (aadsts) {
    // App not found in the tenant / no service principal: consent never happened.
    case "AADSTS700016":
    case "AADSTS65001":
    case "AADSTS500011":
      hint = "consent_missing";
      break;
    // Invalid secret, wrong certificate/assertion.
    case "AADSTS7000215":
    case "AADSTS700027":
    case "AADSTS7000216":
      hint = "invalid_credentials";
      break;
    // Secret or certificate expired.
    case "AADSTS7000222":
    case "AADSTS700024":
      hint = "credentials_expired";
      break;
    // Tenant does not exist / is not a valid audience.
    case "AADSTS90002":
    case "AADSTS900023":
    case "AADSTS50049":
      hint = "tenant_unknown";
      break;
    default:
      if (code === "unauthorized_client") {
        hint = "consent_missing";
      } else if (code === "invalid_client") {
        hint = "invalid_credentials";
      }
  }
  return { hint, code, aadsts, status: error.status ?? null, message: error.message };
}

interface UsersPage {
  value?: Array<{ id?: string; displayName?: string | null; userPrincipalName?: string | null }>;
}

interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

function sampleFrom(page: UsersPage): UserSample[] {
  return (page.value ?? [])
    .filter((user): user is { id: string } & typeof user => typeof user.id === "string")
    .map((user) => ({
      id: user.id,
      displayName: user.displayName ?? null,
      userPrincipalName: user.userPrincipalName ?? null,
    }));
}

/** The test call: list the first users with a minimal select. */
export async function listFirstUsers(
  graph: GraphClient,
  sampleSize: number,
): Promise<TestCallResult> {
  const top = Math.max(1, Math.min(999, Math.floor(sampleSize)));
  const url = `/users?$select=${TEST_CALL_SELECT}&$top=${top}`;
  try {
    const response = await graph.request<UsersPage | GraphErrorBody | string>({
      method: "GET",
      url,
    });
    if (response.status >= 200 && response.status < 300) {
      const page = (response.body ?? {}) as UsersPage;
      const sample = sampleFrom(page);
      return { ok: true, usersSampled: sample.length, sample };
    }
    const body = response.body;
    const error = typeof body === "object" && body !== null ? (body as GraphErrorBody).error : null;
    return {
      ok: false,
      status: response.status,
      code: error?.code ?? null,
      message:
        error?.message ??
        (typeof body === "string" ? body.slice(0, 500) : `HTTP ${response.status}`),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      code: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Run the three-step verification against one customer tenant. */
export async function verifyTenantConnection(
  input: VerifyTenantConnectionInput,
): Promise<ConnectionVerification> {
  const checkedAt = (input.now?.() ?? new Date()).toISOString();

  // A cached token would still carry the roles from before an admin fixed the
  // consent; the whole point of this action is to look at the current state.
  input.tokenProvider.invalidate?.();

  let token: string;
  try {
    token = await input.tokenProvider.getToken();
  } catch (error) {
    const failure =
      error instanceof TokenAcquisitionError
        ? classifyTokenFailure(error)
        : {
            hint: "unknown" as const,
            code: null,
            aadsts: null,
            status: null,
            message: error instanceof Error ? error.message : String(error),
          };
    return {
      checkedAt,
      tokenAcquired: false,
      tokenError: failure,
      permissions: null,
      testCall: null,
      ok: false,
    };
  }

  let roles: string[] = [];
  try {
    roles = rolesFromAccessToken(token);
  } catch {
    // An opaque (non-JWT) token cannot be inspected; the diff then reports
    // everything as missing, and the test call tells the rest of the story.
    roles = [];
  }
  const permissions = diffPermissions(roles);
  const testCall = await listFirstUsers(input.graph, input.sampleSize ?? 5);

  return {
    checkedAt,
    tokenAcquired: true,
    tokenError: null,
    permissions,
    testCall,
    ok: permissions.complete && testCall.ok,
  };
}
