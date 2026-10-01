import { queryOptions } from "@tanstack/react-query";

import { ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/**
 * The second factor on the emergency password path (docs/ARCHITECTURE.md,
 * "Sicherheit"): a password is accepted only together with a TOTP code. The
 * API stamps every session with how it was established (`authMethod`, see
 * apps/api lib/session-assurance.ts). A session opened with the password alone,
 * on an account without an authenticator, may enrol one and nothing else, so
 * the web app sends it straight to the enrolment instead of a shell whose
 * every request would be refused.
 *
 * One exception: the public demo's account (deploy/demo/README.md) signs in
 * with its password alone and is never sent to enrolment, matching the API's
 * own bypass (apps/api lib/demo.ts, lib/session-assurance.ts). Every other
 * account is unaffected, demo mode or not — the check needs the installation's
 * demo configuration (`SetupState.demo`, apps/api routes/setup.ts) to tell them
 * apart, so every call site passes it through explicitly.
 */

/** `session.authMethod` of a sign-in with the password and no second factor. */
export const PASSWORD_ONLY_AUTH_METHOD = "password";

/** Problem type the Restow API answers for a session that must enrol first. */
export const TOTP_ENROLLMENT_REQUIRED_PROBLEM = "urn:restow:problem:totp-enrollment-required";

/** better-auth's provider id for email + password accounts. */
export const PASSWORD_PROVIDER_ID = "credential";

interface SessionShape {
  session: object;
  user: { twoFactorEnabled?: boolean | null; email?: string | null };
}

/** The installation's demo configuration, as `SetupState.demo` reports it. */
export interface DemoAccountConfig {
  enabled: boolean;
  email: string | null;
}

/** How the session was established, as the API recorded it; null when unknown. */
export function sessionAuthMethod(session: SessionShape): string | null {
  const method = (session.session as { authMethod?: unknown }).authMethod;
  return typeof method === "string" ? method : null;
}

/** Whether `session` belongs to the demo account while demo mode is on. */
export function isDemoAccountSession(
  session: SessionShape,
  demo: DemoAccountConfig | null | undefined,
): boolean {
  if (!demo?.enabled || !demo.email) {
    return false;
  }
  const email = session.user.email;
  return (
    typeof email === "string" && email.trim().toLowerCase() === demo.email.trim().toLowerCase()
  );
}

/**
 * Whether this session must set up an authenticator before it can use Restow.
 * `demo` is optional so every existing call keeps its prior behaviour when it
 * is omitted; pass it wherever the installation's demo configuration is
 * available (see the call sites for why: no import cycle, no stale copy).
 */
export function requiresAuthenticatorEnrollment(
  session: SessionShape,
  demo?: DemoAccountConfig | null,
): boolean {
  if (isDemoAccountSession(session, demo)) {
    return false;
  }
  return (
    sessionAuthMethod(session) === PASSWORD_ONLY_AUTH_METHOD &&
    session.user.twoFactorEnabled !== true
  );
}

/** The API refused a request because the session has to enrol an authenticator first. */
export function isEnrollmentRequiredError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.problem?.type === TOTP_ENROLLMENT_REQUIRED_PROBLEM
  );
}

/** How an account can sign in. */
export interface SignInMethods {
  /** The account has an emergency password (and so needs an authenticator app). */
  hasPassword: boolean;
}

export function signInMethodsOf(accounts: readonly { providerId: string }[]): SignInMethods {
  return { hasPassword: accounts.some((account) => account.providerId === PASSWORD_PROVIDER_ID) };
}

/** A failed better-auth account request, with its status for the error views. */
export class SignInMethodsError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Loading the sign-in methods failed with status ${status}`);
    this.name = "SignInMethodsError";
    this.status = status;
  }
}

/** The signed-in account's sign-in methods; under "auth" so tenant switches keep it. */
export const signInMethodsQueryOptions = queryOptions({
  queryKey: ["auth", "sign-in-methods"] as const,
  queryFn: async (): Promise<SignInMethods> => {
    const { data, error } = await authClient.listAccounts();
    if (error) {
      throw new SignInMethodsError(error.status, error.message);
    }
    return signInMethodsOf(data ?? []);
  },
  staleTime: 5 * 60_000,
  retry: false,
});
