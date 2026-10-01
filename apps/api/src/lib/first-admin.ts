import { randomUUID } from "node:crypto";
import { account, user } from "@restow/db";
import { and, eq, like } from "drizzle-orm";
import { auth } from "../auth.js";
import { PROVIDER_ADMIN_USER_ROLE, isProviderAdminRole } from "../middleware/rbac.js";
import { ProblemError } from "../problem.js";
import type { DbExecutor } from "./tenant-context.js";

/**
 * The first provider admin, created inside the setup transaction.
 *
 * better-auth's own `createUser` writes through its adapter on a connection of
 * its own, outside any transaction of ours; an admin created that way survives
 * a setup that fails afterwards, and the half-configured installation would
 * stay open to the next anonymous caller. So setup writes the two rows
 * better-auth's admin `createUser` writes (the user with the `admin` role and
 * its `credential` account with the password hash) on the setup transaction,
 * hashing with better-auth's own configured hasher. Setup either completes as
 * a whole or leaves nothing behind.
 *
 * No existing account is ever promoted: setup creates a new account or, for an
 * installation left half-configured by an earlier version (an admin without
 * settings), continues with that very admin after its password checked out.
 */

/** What setup does about the first provider admin. */
export type FirstAdminPlan =
  | { kind: "create" }
  | { kind: "resume"; userId: string }
  | { kind: "conflict"; reason: "administrator_exists" | "email_in_use" };

export interface ExistingAccount {
  id: string;
  email: string;
  role: string | null;
}

/**
 * Decide from the accounts that exist: a provider admin can only be continued
 * with (same email, password verified by the caller), an account that is not
 * an admin is never touched, and otherwise the admin is created.
 */
export function planFirstAdmin(
  email: string,
  providerAdmins: readonly ExistingAccount[],
  emailOwner: ExistingAccount | null,
): FirstAdminPlan {
  const normalized = email.trim().toLowerCase();
  if (providerAdmins.length > 0) {
    const same = providerAdmins.find((admin) => admin.email.toLowerCase() === normalized);
    return same
      ? { kind: "resume", userId: same.id }
      : { kind: "conflict", reason: "administrator_exists" };
  }
  return emailOwner ? { kind: "conflict", reason: "email_in_use" } : { kind: "create" };
}

function conflictProblem(reason: "administrator_exists" | "email_in_use"): ProblemError {
  return reason === "email_in_use"
    ? new ProblemError(409, "Email already in use", {
        type: "urn:restow:problem:email-in-use",
        detail:
          "An account with this email already exists. Choose another email for the administrator.",
        extensions: { field: "firstAdmin.email" },
      })
    : new ProblemError(409, "Administrator already exists", {
        type: "urn:restow:problem:administrator-exists",
        detail:
          "An unfinished setup already created an administrator. Continue with that administrator's email and password.",
      });
}

/** An id the way better-auth would generate it (its configured generator), else a UUID. */
function newId(
  context: { generateId(options: { model: "user" | "account" }): string | false },
  model: "user" | "account",
): string {
  return context.generateId({ model }) || randomUUID();
}

export interface FirstAdminInput {
  name: string;
  email: string;
  password: string;
}

/**
 * Create the first provider admin on `tx`, or continue with the one an
 * unfinished setup left behind. Throws a 409 problem for every other case.
 */
export async function claimFirstAdmin(
  tx: DbExecutor,
  input: FirstAdminInput,
): Promise<{ userId: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const candidates = await tx
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(like(user.role, `%${PROVIDER_ADMIN_USER_ROLE}%`));
  const [emailOwner] = await tx
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  const plan = planFirstAdmin(
    email,
    candidates.filter((candidate) => isProviderAdminRole(candidate.role)),
    emailOwner ?? null,
  );
  const context = await auth.$context;

  if (plan.kind === "conflict") {
    throw conflictProblem(plan.reason);
  }
  if (plan.kind === "resume") {
    const [credential] = await tx
      .select({ password: account.password })
      .from(account)
      .where(and(eq(account.userId, plan.userId), eq(account.providerId, "credential")))
      .limit(1);
    const verified =
      credential?.password != null &&
      (await context.password.verify({ hash: credential.password, password: input.password }));
    if (!verified) {
      throw conflictProblem("administrator_exists");
    }
    return { userId: plan.userId, created: false };
  }

  const userId = newId(context, "user");
  await tx.insert(user).values({
    id: userId,
    name: input.name,
    email,
    emailVerified: false,
    role: PROVIDER_ADMIN_USER_ROLE,
  });
  await tx.insert(account).values({
    id: newId(context, "account"),
    accountId: userId,
    providerId: "credential",
    userId,
    password: await context.password.hash(input.password),
  });
  return { userId, created: true };
}
