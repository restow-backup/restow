import type { SetupState } from "@/lib/api";
import type { AuthResult } from "@/lib/auth-client";
import { LOGIN_PATH } from "@/lib/entry";

/**
 * Pure decisions of the login page: which `auth:` message explains a failed
 * sign-in, where a sign-in with Microsoft returns to when it fails, and
 * whether the public demo's account (deploy/demo/README.md) is ready to
 * offer a one-click sign-in.
 */

export interface DemoCredentials {
  email: string;
  password: string;
}

/**
 * The demo account's credentials, ready to sign in with, or null when demo
 * mode is off or the operator left a credential unset (`SetupState.demo`).
 */
export function demoCredentialsOf(demo: SetupState["demo"] | undefined): DemoCredentials | null {
  if (!demo?.enabled || !demo.email || !demo.password) {
    return null;
  }
  return { email: demo.email, password: demo.password };
}

/** The steps of the emergency sign-in. */
export type SignInPhase = "password" | "totp" | "backupCode";

/** The provider id of Entra ID sign-in (generic OAuth, apps/api/src/auth.ts). */
export const MICROSOFT_PROVIDER = "microsoft";

type AuthError = NonNullable<AuthResult<unknown>["error"]>;

/** Translate a better-auth error envelope into an `auth:` message key. */
export function signInErrorKey(
  error: AuthError,
  phase: SignInPhase | "passkey" | "microsoft",
): string {
  const code = error.code ?? "";
  if (error.status === 0 || error.status >= 500) {
    return "login.error.network";
  }
  if (
    error.status === 429 ||
    code === "ACCOUNT_TEMPORARILY_LOCKED" ||
    code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"
  ) {
    return "login.error.locked";
  }
  if (phase === "totp") {
    return "login.error.invalidTotp";
  }
  if (phase === "backupCode") {
    return "login.error.invalidBackupCode";
  }
  if (phase === "passkey") {
    return code.includes("ABORTED") || code.includes("CANCELLED")
      ? "login.error.passkeyCancelled"
      : "login.error.passkeyFailed";
  }
  if (phase === "microsoft") {
    return "login.error.microsoftFailed";
  }
  // The API refuses the password alone for an account whose second factor is a passkey.
  if (code === "PASSKEY_SIGN_IN_REQUIRED") {
    return "login.error.passkeyRequired";
  }
  if (error.status === 401 || error.status === 403 || code === "INVALID_EMAIL_OR_PASSWORD") {
    return "login.error.invalidCredentials";
  }
  return "login.error.generic";
}

/** Explain the `error` code better-auth appends when a sign-in with Microsoft fails. */
export function microsoftErrorKey(code: string): string {
  switch (code) {
    case "access_denied":
      return "login.error.microsoftCancelled";
    case "account_not_linked":
    case "unable_to_link_account":
      return "login.error.microsoftNotLinked";
    case "email_not_found":
    case "unable_to_get_user_info":
      return "login.error.microsoftNoEmail";
    default:
      return "login.error.microsoftFailed";
  }
}

/** The login page a failed Microsoft sign-in comes back to, keeping the deep link. */
export function loginReturnPath(target: string | null): string {
  return target
    ? `${LOGIN_PATH}?${new URLSearchParams({ redirect: target }).toString()}`
    : LOGIN_PATH;
}
