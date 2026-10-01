import { ApiError } from "@/lib/api";

/**
 * Step-up for the few actions that decide what runs on the server or on a
 * machine, or open its backups (apps/api lib/recent-sign-in.ts): changing the
 * update source or its access token, announcing an update, setting or changing
 * an endpoint's hooks and showing its repository password. The API answers 403
 * with this problem type when the session is older than a few minutes; the
 * web app then asks the person to confirm it is them
 * (components/confirm-identity-dialog.tsx) and repeats the action.
 */

/** Problem type of an action that needs a recent sign-in. */
export const RECENT_SIGN_IN_PROBLEM = "urn:restow:problem:recent-sign-in-required";

/** The API refused the action until the person confirms with a fresh sign-in. */
export function isRecentSignInRequired(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.problem?.type === RECENT_SIGN_IN_PROBLEM
  );
}

/**
 * Whether to offer the passkey: the installation offers passkey sign-in, the
 * browser can do it and the account has at least one. Everyone else signs in
 * again on the sign-in page (password and authenticator code, or their usual way).
 */
export function offersPasskeyConfirmation(input: {
  passkeyReady: boolean;
  browserSupportsPasskeys: boolean;
  passkeys: number | null;
}): boolean {
  return input.passkeyReady && input.browserSupportsPasskeys && (input.passkeys ?? 0) > 0;
}
