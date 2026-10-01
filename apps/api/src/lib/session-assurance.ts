import { isProviderAdminRole } from "../middleware/rbac.js";

/**
 * Session assurance (docs/STACK.md "Auth"): passkeys are the primary sign-in,
 * and the password exists only as an emergency path with mandatory TOTP. What
 * a better-auth session may do therefore follows from how it was established,
 * which the session hook records as `session.authMethod`:
 *
 *   full            — passkey, password plus TOTP, Entra sign-in (and better-auth
 *                     impersonation, which the Restow routes refuse on their own);
 *   totp_enrollment — a password alone on an account without an authenticator:
 *                     the session may enroll TOTP (and sign out), nothing else;
 *   reauthenticate  — a password-only session of an account that has TOTP by
 *                     now, or a session of unknown origin: it is discarded and
 *                     the user signs in again.
 *
 * Pure functions only; the better-auth hooks and the API middleware apply them.
 */

export const AUTH_METHODS = [
  "password",
  "password_totp",
  "passkey",
  "oidc",
  "impersonation",
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export type SessionAssurance = "full" | "totp_enrollment" | "reauthenticate";

const STRONG_METHODS: ReadonlySet<string> = new Set<AuthMethod>([
  "password_totp",
  "passkey",
  "oidc",
  "impersonation",
]);

/** How the user proved who they are, from the better-auth endpoint that created the session. */
export function authMethodForPath(path: string | null | undefined): AuthMethod | null {
  switch (path) {
    case "/sign-in/email":
      return "password";
    case "/two-factor/verify-totp":
    case "/two-factor/verify-backup-code":
    case "/two-factor/verify-otp":
      return "password_totp";
    case "/passkey/verify-authentication":
    case "/passkey/verify-registration":
      return "passkey";
    case "/admin/impersonate-user":
      return "impersonation";
    default:
      return path?.startsWith("/oauth2/callback/") || path?.startsWith("/callback/")
        ? "oidc"
        : null;
  }
}

/**
 * The method to store on a new session: the creating endpoint decides; a
 * session that merely replaces another (password change, TOTP disable) keeps
 * the method of the one it replaces.
 */
export function authMethodForNewSession(
  path: string | null | undefined,
  inherited: string | null | undefined,
): string | null {
  return authMethodForPath(path) ?? inherited ?? null;
}

export interface SessionFacts {
  /** `session.authMethod`; unknown values are treated like a missing one. */
  authMethod: unknown;
}

export interface UserFacts {
  twoFactorEnabled: boolean | null | undefined;
}

export interface SessionAssuranceOptions {
  /**
   * True only for the demo account while demo mode is on (config.ts
   * `RESTOW_DEMO`, checked by the caller with lib/demo.ts `isDemoAccountEmail`):
   * a password sign-in is treated as fully assured, without a TOTP challenge
   * or enrolment. Every other account is unaffected, demo mode or not.
   */
  demoPasswordBypass?: boolean;
}

export function sessionAssurance(
  session: SessionFacts,
  user: UserFacts,
  options: SessionAssuranceOptions = {},
): SessionAssurance {
  const method = typeof session.authMethod === "string" ? session.authMethod : null;
  if (method !== null && STRONG_METHODS.has(method)) {
    return "full";
  }
  if (method === "password") {
    if (options.demoPasswordBypass) {
      return "full";
    }
    if (!user.twoFactorEnabled) {
      return "totp_enrollment";
    }
  }
  // A password session of an account that enrolled TOTP since (the enrollment
  // replaced the enrolling session, so this one is another), or a session
  // whose origin was never recorded: neither proves a second factor.
  return "reauthenticate";
}

// --- Which endpoints a restricted session may reach ---------------------------------

/**
 * Endpoints that never act on an existing session: signing in (again) must
 * stay possible whatever cookie the browser still holds.
 */
export function isSignInPath(path: string): boolean {
  return (
    path === "/sign-in/email" ||
    path === "/sign-in/social" ||
    path === "/sign-in/oauth2" ||
    path === "/passkey/generate-authenticate-options" ||
    path === "/passkey/verify-authentication" ||
    path === "/two-factor/verify-backup-code" ||
    path === "/ok" ||
    path === "/error" ||
    path.startsWith("/oauth2/callback/") ||
    path.startsWith("/callback/")
  );
}

/** What a `totp_enrollment` session may do besides signing in: enroll, look, leave. */
const ENROLLMENT_PATHS: ReadonlySet<string> = new Set([
  "/get-session",
  "/sign-out",
  "/two-factor/enable",
  "/two-factor/get-totp-uri",
  "/two-factor/verify-totp",
]);

/** What a `reauthenticate` session may still reach: reading "no session" and signing out. */
const REAUTHENTICATE_PATHS: ReadonlySet<string> = new Set(["/get-session", "/sign-out"]);

export function isPathAllowed(assurance: SessionAssurance, path: string): boolean {
  if (assurance === "full" || isSignInPath(path)) {
    return true;
  }
  return assurance === "totp_enrollment"
    ? ENROLLMENT_PATHS.has(path)
    : REAUTHENTICATE_PATHS.has(path);
}

// --- The last provider admin ------------------------------------------------------------

type RoleValue = string | string[] | undefined;

function joinRoles(role: RoleValue): string {
  return Array.isArray(role) ? role.join(",") : (role ?? "");
}

/**
 * The user a better-auth admin request would strip of the provider-admin
 * role (demote, ban or delete), or null when it would not. The caller then
 * refuses the request if that user is the last active provider admin: the
 * installation must never end up without one, since the setup wizard stays
 * closed for good.
 */
export function providerAdminRevocationTarget(path: string, body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const record = body as { userId?: unknown; role?: RoleValue; data?: unknown };
  const userId = typeof record.userId === "string" ? record.userId : null;
  if (!userId) {
    return null;
  }
  switch (path) {
    case "/admin/remove-user":
    case "/admin/ban-user":
      return userId;
    case "/admin/set-role":
      return isProviderAdminRole(joinRoles(record.role)) ? null : userId;
    case "/admin/update-user": {
      const data = (record.data ?? {}) as { role?: RoleValue; banned?: unknown };
      const demoted = "role" in data && !isProviderAdminRole(joinRoles(data.role));
      return demoted || data.banned === true ? userId : null;
    }
    default:
      return null;
  }
}

export interface AdminAccount {
  id: string;
  role: string | null;
  banned: boolean | null;
}

/** True when `targetId` is the only active (not banned) provider admin among `accounts`. */
export function wouldRemoveLastProviderAdmin(
  targetId: string,
  accounts: readonly AdminAccount[],
): boolean {
  const active = accounts.filter((account) => isProviderAdminRole(account.role) && !account.banned);
  return active.length === 1 && active[0]?.id === targetId;
}
