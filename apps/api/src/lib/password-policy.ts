/**
 * Password policy for the emergency password path. Passkeys are the primary
 * login; the password exists as a fallback gated by TOTP, and both better-auth
 * (`emailAndPassword.minPasswordLength`) and the setup wizard enforce this.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
