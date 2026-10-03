import { account, passkey, session, twoFactor, user } from "@restow/db";
import { and, eq } from "drizzle-orm";
import type { Transaction } from "./tenant-context.js";

/**
 * Taking an account's ways to sign in away, inside the caller's transaction:
 * shared by the administrator recovery on the command line
 * (cli/admin-recovery.ts, which then sets a new password) and the owner's
 * "Reset access" of a provider team member (features/provider-team, which
 * then issues a fresh set-password link).
 *
 * A lost device must not keep working, so the authenticator app (TOTP) and
 * every passkey go; every session of the account ends with them. A password
 * sign-in is refused while an account has a passkey but no authenticator app
 * (lib/auth-hooks.ts), and a password-only session must enrol an
 * authenticator app before anything else (lib/session-assurance.ts), so the
 * person sets up their second factor again after the reset.
 */

export interface SignInReset {
  /** The `credential` account row (the password) was deleted. */
  passwordRemoved: boolean;
  authenticatorRemoved: boolean;
  passkeysRemoved: number;
  sessionsEnded: number;
}

/**
 * Remove the authenticator app, every passkey and every session of `userId`
 * and, with `removePassword`, the password too (its `credential` account row;
 * an account linked to another provider, such as Microsoft, keeps that link).
 */
export async function resetSignInMethods(
  tx: Transaction,
  userId: string,
  { removePassword }: { removePassword: boolean },
): Promise<SignInReset> {
  const removedPasswords = removePassword
    ? await tx
        .delete(account)
        .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
        .returning({ id: account.id })
    : [];
  const removedFactors = await tx
    .delete(twoFactor)
    .where(eq(twoFactor.userId, userId))
    .returning({ id: twoFactor.id });
  await tx
    .update(user)
    .set({ twoFactorEnabled: false, updatedAt: new Date() })
    .where(eq(user.id, userId));
  const removedPasskeys = await tx
    .delete(passkey)
    .where(eq(passkey.userId, userId))
    .returning({ id: passkey.id });
  const endedSessions = await tx
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  return {
    passwordRemoved: removedPasswords.length > 0,
    authenticatorRemoved: removedFactors.length > 0,
    passkeysRemoved: removedPasskeys.length,
    sessionsEnded: endedSessions.length,
  };
}
