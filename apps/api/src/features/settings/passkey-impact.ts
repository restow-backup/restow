import { user } from "@restow/db";
import { and, eq, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * Who loses their way in when passkeys stop working (installation settings,
 * operating mode and public URL).
 *
 * A passkey is bound to the host name of the public URL (the WebAuthn relying
 * party). Switching to the local mode hides the passkey sign-in, and moving the
 * public URL to another host makes every registered passkey useless. Accounts
 * that also have a password and an authenticator app sign in with those
 * instead; an account whose only way in is a passkey cannot sign in at all
 * (a password sign-in without an authenticator app is refused,
 * lib/auth-hooks.ts `PASSKEY_SIGN_IN_REQUIRED`) until someone resets its
 * access. The settings page shows these numbers before it asks to confirm.
 */

export interface SignInFacts {
  userId: string;
  hasPasskey: boolean;
  hasPassword: boolean;
  hasAuthenticator: boolean;
}

export interface PasskeyImpact {
  /** Active accounts with at least one passkey. */
  accountsWithPasskeys: number;
  /** Of those, the accounts without password plus authenticator app: they could not sign in. */
  accountsLockedOut: number;
  /** The requesting account. */
  self: {
    hasPasskey: boolean;
    hasPassword: boolean;
    hasAuthenticator: boolean;
    lockedOut: boolean;
  };
}

/** Whether an account has no way in once its passkeys stop working. */
export function locksOut(facts: Omit<SignInFacts, "userId">): boolean {
  return facts.hasPasskey && !(facts.hasPassword && facts.hasAuthenticator);
}

/** The numbers from one row per account (only accounts with a passkey matter for the counts). */
export function summarisePasskeyImpact(
  rows: readonly SignInFacts[],
  self: Omit<SignInFacts, "userId">,
): PasskeyImpact {
  const withPasskeys = rows.filter((row) => row.hasPasskey);
  return {
    accountsWithPasskeys: withPasskeys.length,
    accountsLockedOut: withPasskeys.filter(locksOut).length,
    self: { ...self, lockedOut: locksOut(self) },
  };
}

async function signInFacts(db: DbExecutor, onlyUserId?: string): Promise<SignInFacts[]> {
  // Spelled out with table names: in a select list drizzle leaves columns
  // unqualified, and "id" inside the subquery would be the passkey's own.
  const hasPasskey = sql<boolean>`exists (select 1 from "passkey" where "passkey"."user_id" = "user"."id")`;
  const hasPassword = sql<boolean>`exists (select 1 from "account" where "account"."user_id" = "user"."id" and "account"."provider_id" = 'credential' and "account"."password" is not null)`;
  const rows = await db
    .select({
      userId: user.id,
      hasPasskey,
      hasPassword,
      hasAuthenticator: user.twoFactorEnabled,
    })
    .from(user)
    .where(
      onlyUserId
        ? eq(user.id, onlyUserId)
        : and(or(eq(user.banned, false), sql`${user.banned} is null`), hasPasskey),
    );
  return rows.map((row) => ({
    userId: row.userId,
    hasPasskey: row.hasPasskey === true,
    hasPassword: row.hasPassword === true,
    hasAuthenticator: row.hasAuthenticator === true,
  }));
}

export async function getPasskeyImpact(db: DbExecutor, selfId: string): Promise<PasskeyImpact> {
  const [rows, [self]] = await Promise.all([signInFacts(db), signInFacts(db, selfId)]);
  return summarisePasskeyImpact(rows, {
    hasPasskey: self?.hasPasskey ?? false,
    hasPassword: self?.hasPassword ?? false,
    hasAuthenticator: self?.hasAuthenticator ?? false,
  });
}
