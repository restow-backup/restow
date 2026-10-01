import { randomUUID } from "node:crypto";
import {
  type Database,
  account,
  passkey,
  providerMembers,
  session,
  settings,
  twoFactor,
  user,
} from "@restow/db";
import { and, asc, count, eq, like } from "drizzle-orm";
import { auth } from "../auth.js";
import { audit } from "../lib/audit.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../lib/password-policy.js";
import type { DbExecutor } from "../lib/tenant-context.js";
import { PROVIDER_ADMIN_USER_ROLE, isProviderAdminRole } from "../middleware/rbac.js";

/**
 * Administrator access recovery on the server's command line (`restow admin
 * recover`, ./main.ts): the way back in when an owner of the provider team has
 * lost their passkeys, their authenticator app or their password.
 *
 * The setup wizard is closed for good once the installation is set up, and no
 * route of the web interface or the API hands out access without a sign-in.
 * Whoever can run a command in the api container already controls the server,
 * its database and its keys, so this is where recovery lives. It is limited to
 * owners: every other member of the provider team is reset by an owner in
 * Settings > Team.
 *
 * Recovery, in one transaction on the installation pool:
 *   - sets the new password the operator typed (the credential account is
 *     created when the owner had only passkeys),
 *   - removes the authenticator app (TOTP) and every passkey: a lost device
 *     must not keep working (and a password sign-in is refused while an
 *     account has a passkey but no authenticator app, lib/auth-hooks.ts),
 *   - ends every session of the account,
 *   - writes `account.access_recovered` to the installation audit chain.
 *
 * The owner then signs in with the new password and has to set up an
 * authenticator app before anything else (lib/session-assurance.ts), exactly
 * like the first administrator after setup.
 */

export const RECOVERY_AUDIT_ACTIONS = {
  recovered: "account.access_recovered",
} as const;

export type RecoveryRefusal =
  | "not_found"
  | "not_provider_admin"
  | "not_owner"
  | "disabled"
  | "password_policy";

/** A recovery that is refused, with the reason the command prints. */
export class RecoveryError extends Error {
  constructor(
    readonly reason: RecoveryRefusal,
    message: string,
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

export interface AdminSummary {
  email: string;
  name: string;
  /** The provider team role; `owner` for an admin without a team row (the first admin). */
  teamRole: string;
  authenticatorApp: boolean;
  passkeys: number;
  password: boolean;
  disabled: boolean;
}

export interface RecoveryInput {
  email: string;
  password: string;
}

export interface RecoveryResult {
  userId: string;
  email: string;
  passwordCreated: boolean;
  authenticatorRemoved: boolean;
  passkeysRemoved: number;
  sessionsEnded: number;
}

/** Why a new password is not acceptable, or null when it is. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `The password must have at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/** Every provider administrator, owners first, for `restow admin list`. */
export async function listProviderAdmins(db: Database): Promise<AdminSummary[]> {
  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      banned: user.banned,
      twoFactorEnabled: user.twoFactorEnabled,
      teamRole: providerMembers.role,
    })
    .from(user)
    .leftJoin(providerMembers, eq(providerMembers.userId, user.id))
    // Narrowed in SQL (end users can be thousands), decided exactly below.
    .where(like(user.role, `%${PROVIDER_ADMIN_USER_ROLE}%`))
    .orderBy(asc(user.email));
  const admins = rows.filter((row) => isProviderAdminRole(row.role));
  const summaries: AdminSummary[] = [];
  for (const admin of admins) {
    const [keys] = await db
      .select({ value: count() })
      .from(passkey)
      .where(eq(passkey.userId, admin.id));
    const [credential] = await db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, admin.id), eq(account.providerId, "credential")))
      .limit(1);
    summaries.push({
      email: admin.email,
      name: admin.name,
      teamRole: admin.teamRole ?? "owner",
      authenticatorApp: admin.twoFactorEnabled === true,
      passkeys: Number(keys?.value ?? 0),
      password: credential !== undefined,
      disabled: admin.banned === true,
    });
  }
  return summaries.sort((a, b) => Number(b.teamRole === "owner") - Number(a.teamRole === "owner"));
}

/**
 * The account `email` names, when recovery may act on it: an enabled owner of
 * the provider team. Throws {@link RecoveryError} with the reason otherwise.
 * Changes nothing; `recoverAdminAccess` checks again inside its transaction.
 */
export async function recoveryTarget(
  db: DbExecutor,
  rawEmail: string,
  { lock = false }: { lock?: boolean } = {},
): Promise<{ id: string; email: string }> {
  const email = rawEmail.trim().toLowerCase();
  const query = db
    .select({ id: user.id, role: user.role, banned: user.banned })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  const [target] = lock ? await query.for("update") : await query;
  if (!target) {
    throw new RecoveryError("not_found", `There is no account with the email ${email}.`);
  }
  if (!isProviderAdminRole(target.role)) {
    throw new RecoveryError(
      "not_provider_admin",
      `${email} is not an administrator of this installation. Accounts of a tenant are reset by its administrators in the web interface.`,
    );
  }
  const [member] = await db
    .select({ role: providerMembers.role })
    .from(providerMembers)
    .where(eq(providerMembers.userId, target.id))
    .limit(1);
  if (member && member.role !== "owner") {
    throw new RecoveryError(
      "not_owner",
      `${email} is a member of the provider team with the role ${member.role}, not an owner. An owner resets their access in Settings > Team.`,
    );
  }
  if (target.banned) {
    throw new RecoveryError(
      "disabled",
      `${email} is disabled. Recovery does not enable an account that an administrator disabled.`,
    );
  }
  return { id: target.id, email };
}

/** Where the owner signs in afterwards: the public URL of the setup, else the environment's. */
export async function signInUrl(
  db: Database,
  fallback: string | undefined,
): Promise<string | null> {
  const [row] = await db.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
  const base = row?.publicUrl ?? fallback ?? null;
  return base ? `${base.replace(/\/+$/, "")}/login` : null;
}

/** Restore an owner's access (see the module comment). Throws {@link RecoveryError}. */
export async function recoverAdminAccess(
  db: Database,
  input: RecoveryInput,
): Promise<RecoveryResult> {
  const problem = passwordProblem(input.password);
  if (problem) {
    throw new RecoveryError("password_policy", problem);
  }
  const context = await auth.$context;
  const hashed = await context.password.hash(input.password);

  return db.transaction(async (tx) => {
    const target = await recoveryTarget(tx, input.email, { lock: true });
    const email = target.email;

    const [credential] = await tx
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, target.id), eq(account.providerId, "credential")))
      .limit(1);
    if (credential) {
      await tx
        .update(account)
        .set({ password: hashed, updatedAt: new Date() })
        .where(eq(account.id, credential.id));
    } else {
      await tx.insert(account).values({
        id: context.generateId({ model: "account" }) || randomUUID(),
        accountId: target.id,
        providerId: "credential",
        userId: target.id,
        password: hashed,
      });
    }

    const removedFactors = await tx
      .delete(twoFactor)
      .where(eq(twoFactor.userId, target.id))
      .returning({ id: twoFactor.id });
    await tx
      .update(user)
      .set({ twoFactorEnabled: false, updatedAt: new Date() })
      .where(eq(user.id, target.id));
    const removedPasskeys = await tx
      .delete(passkey)
      .where(eq(passkey.userId, target.id))
      .returning({ id: passkey.id });
    const endedSessions = await tx
      .delete(session)
      .where(eq(session.userId, target.id))
      .returning({ id: session.id });

    const result: RecoveryResult = {
      userId: target.id,
      email,
      passwordCreated: credential === undefined,
      authenticatorRemoved: removedFactors.length > 0,
      passkeysRemoved: removedPasskeys.length,
      sessionsEnded: endedSessions.length,
    };
    await audit(tx, {
      actor: "system",
      actorUserId: null,
      action: RECOVERY_AUDIT_ACTIONS.recovered,
      target: target.id,
      targetType: "user",
      onBehalfOf: email,
      ip: null,
      details: {
        via: "command_line",
        passwordCreated: result.passwordCreated,
        authenticatorRemoved: result.authenticatorRemoved,
        passkeysRemoved: result.passkeysRemoved,
        sessionsEnded: result.sessionsEnded,
      },
    });
    return result;
  });
}
