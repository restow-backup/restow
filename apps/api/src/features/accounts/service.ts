import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  account,
  member,
  passkey,
  providerMembers,
  settings,
  tenants,
  user,
  verification,
} from "@restow/db";
import { type SupportedLanguage, createI18n } from "@restow/i18n";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { auth } from "../../auth.js";
import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { authCall } from "../../lib/auth-errors.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import {
  type TenantRole,
  isProviderAdminRole,
  membershipRoleFromTenantRole,
  tenantRoleFromMembership,
} from "../../middleware/rbac.js";
import type { TenantContext } from "../../middleware/session.js";
import type { Notifier } from "../../notify.js";
import { ProblemError } from "../../problem.js";
import { createInstallationNotifier } from "../settings/service.js";
import type { ProvisionAccountInput } from "./schemas.js";

/**
 * Account provisioning for people without Microsoft sign-in: a tenant admin
 * (or provider admin) creates or reuses a better-auth user, adds the tenant
 * membership and issues a single-use, 72h set-password link. The token itself
 * is never stored: only its SHA-256 lives in better-auth's own `verification`
 * table (identifier-indexed), alongside the user and tenant it belongs to and
 * whether it has been redeemed yet. Redeeming it writes the account's
 * `credential` password the same way apps/api/src/lib/first-admin.ts writes
 * the first admin's: directly, with better-auth's own configured hasher.
 *
 * A link is only ever issued for an account that cannot already sign in some
 * other way. Reusing an existing account by email must never become a way to
 * take it over: an account that already has a credential password, a
 * passkey or a linked Microsoft sign-in only gets the tenant membership, the
 * same way the tenants feature's own `addMember` adds an existing user; a
 * provider administrator is never a valid target at all (it needs no tenant
 * membership to reach every tenant); and a tenant admin may only reach an
 * account that is not already a member of a different tenant — only a
 * provider admin may add the same person into more than one. The tenants
 * feature's `addMember` applies that same cross-tenant refusal and, when it
 * adds an existing account that still has no working sign-in, invalidates
 * whatever set-password link this feature issued for it, so a link one admin
 * holds cannot survive the person picking up a membership added the other
 * way.
 *
 * A link itself also remembers whether a provider admin issued it
 * (`issuedByProviderAdmin`): only a provider admin may legitimately place the
 * same person in more than one tenant, so `redeemSetPasswordToken` refuses
 * any other link once the person has gained a membership outside the tenant
 * it was issued for, whichever path added it.
 *
 * The raw token is handed back to the caller (`setPasswordToken`) only when
 * it could not also be mailed to the address itself: once delivery to that
 * address succeeds, the admin gets nothing to copy, so an admin can never
 * read back — and redeem for themselves — a link meant for someone else's
 * mailbox (`revealSetPasswordToken`).
 */

export const ACCOUNT_AUDIT_ACTIONS = {
  provisioned: "account.provisioned",
  linkIssued: "account.password_link_issued",
  passwordSet: "account.password_set",
} as const;

export interface Actor {
  id: string;
  email: string;
  ip: string | null;
  /** Provider admins may provision across tenants; tenant admins may not. */
  isProviderAdmin: boolean;
}

/** Who a set-password link is redeemed by; no session exists yet. */
export interface RedeemActor {
  ip: string | null;
}

export type LinkStatus = "valid" | "expired" | "used" | "invalid";

/** Whether the set-password link could also be emailed through the configured transport. */
export type MailOutcome = "sent" | "not_configured" | "failed";

export interface ProvisionResult {
  userId: string;
  email: string;
  name: string;
  role: TenantRole;
  /** A brand new better-auth user was created; false when an existing account was reused. */
  created: boolean;
  /**
   * False when the person already had a working way to sign in (a password,
   * a passkey or a linked Microsoft account): only the tenant membership was
   * added, and the remaining fields below are all empty — there is no link
   * to show.
   */
  linkIssued: boolean;
  linkExpiresAt: string | null;
  /** The raw token, shown to the admin exactly once (never stored, never logged). */
  setPasswordToken: string | null;
  mailOutcome: MailOutcome;
}

export interface PendingAccountDto {
  userId: string;
  name: string;
  email: string;
  role: TenantRole;
  invitedAt: string;
  linkStatus: LinkStatus;
  linkExpiresAt: string | null;
}

export interface LinkCheckResult {
  status: LinkStatus;
  /** A masked hint ("j***@example.com"), never the full address, for an unauthenticated caller. */
  emailHint: string | null;
}

export interface RedeemResult {
  userId: string;
  email: string;
}

const LINK_TTL_MS = 72 * 60 * 60 * 1000;
const VERIFICATION_PREFIX = "account-set-password:";
const TOKEN_BYTES = 32;

/** Pending accounts are provisioned one admin at a time; this comfortably covers real tenants. */
const DEFAULT_PENDING_LIMIT = 100;
const MAX_PENDING_LIMIT = 200;

/** A tenant that still has an organization and is not being deleted. */
function requireOrganization(tenant: Pick<TenantContext, "organizationId" | "status">): string {
  if (!tenant.organizationId || tenant.status === "deleting") {
    throw new ProblemError(409, "Tenant is being deleted");
  }
  return tenant.organizationId;
}

function providerAdminTargetProblem(): ProblemError {
  return new ProblemError(403, "Cannot provision a provider administrator", {
    type: "urn:restow:problem:account-provider-admin-target",
    detail:
      "This account administers the whole installation and already reaches every tenant; it is not provisioned into one.",
  });
}

/**
 * Exported for the tenants feature's own `addMember`: adding an existing
 * user to a tenant is the same operation this feature's `provisionAccount`
 * performs when the email already has an account, and it must refuse a
 * cross-tenant target for exactly the same, non-provider-admin actors (see
 * the account-takeover note above `provisionAccount`).
 */
export function crossTenantTargetProblem(): ProblemError {
  return new ProblemError(403, "Belongs to another tenant", {
    type: "urn:restow:problem:account-cross-tenant",
    detail:
      "This account already belongs to a different tenant. Only a provider administrator can add it here too.",
  });
}

function notPendingProblem(): ProblemError {
  return new ProblemError(409, "Nothing to reissue", {
    type: "urn:restow:problem:account-not-pending",
    detail: "This person already has a working way to sign in; there is no link to reissue.",
  });
}

/**
 * Whether `userId` already has a working way to sign in: any better-auth
 * `account` row (a `credential` password or a linked provider such as
 * Microsoft) or a passkey. Provisioning and reissuing must never touch a link
 * for such an account, and redeeming must never overwrite its password.
 */
export async function hasSignInMethod(db: DbExecutor, userId: string): Promise<boolean> {
  const [accountRow] = await db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.userId, userId))
    .limit(1);
  if (accountRow) {
    return true;
  }
  const [passkeyRow] = await db
    .select({ id: passkey.id })
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .limit(1);
  return Boolean(passkeyRow);
}

/** Whether `userId` already belongs to an organization other than `organizationId`. */
export async function belongsToOtherTenant(
  db: DbExecutor,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), ne(member.organizationId, organizationId)))
    .limit(1);
  return Boolean(row);
}

// --- Token & the verification row --------------------------------------------------

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function identifierOf(token: string): string {
  return `${VERIFICATION_PREFIX}${hashToken(token)}`;
}

interface LinkValue {
  userId: string;
  /**
   * The tenant the link was issued for; null for an invitation into the
   * provider team (ee/api provider-team), which belongs to no tenant.
   */
  tenantId: string | null;
  used: boolean;
  /**
   * Whether a provider admin (who may legitimately add the same person to
   * more than one tenant) issued this link, as opposed to a tenant admin (who
   * may not). `redeemSetPasswordToken` refuses to redeem a tenant-admin-issued
   * link once the person has gained any membership outside `tenantId` by the
   * time it is redeemed: a tenant admin must never be able to hand themselves
   * a working password for an account that has since become, or already was,
   * someone else's in another tenant. Missing on a link written before this
   * field existed, which decodes as `false` — the safer default.
   */
  issuedByProviderAdmin: boolean;
}

function encodeLinkValue(value: LinkValue): string {
  return JSON.stringify(value);
}

function decodeLinkValue(raw: string): LinkValue | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LinkValue>;
    if (
      typeof parsed.userId === "string" &&
      (typeof parsed.tenantId === "string" || parsed.tenantId === null) &&
      typeof parsed.used === "boolean"
    ) {
      return {
        userId: parsed.userId,
        tenantId: parsed.tenantId,
        used: parsed.used,
        issuedByProviderAdmin: parsed.issuedByProviderAdmin === true,
      };
    }
  } catch {
    // Malformed value: treated as no link below.
  }
  return null;
}

/**
 * A second `verification` row per user, `account-set-password-user:<userId>`,
 * pointing at that user's one active link row (`linkIdentifier`). `identifier`
 * carries a btree index (packages/db/src/schema/auth.ts), so both this row and
 * the link row it points at are found by an exact, indexed match — instead of
 * decoding every set-password row this feature has ever written, which would
 * grow without bound as more accounts are provisioned over the life of the
 * installation. The pointer is only ever consulted for a person's *current*
 * link (invalidating it on reissue, showing its status while pending); once
 * redeemed, the person no longer shows up as pending at all (`listPendingAccounts`
 * excludes anyone with a credential), so it does not need to track that.
 */
const POINTER_PREFIX = "account-set-password-user:";

function pointerIdentifierOf(userId: string): string {
  return `${POINTER_PREFIX}${userId}`;
}

interface PointerValue {
  /** The active link row's own `identifier`, so it can be found and removed alongside this pointer. */
  linkIdentifier: string;
}

function encodePointerValue(value: PointerValue): string {
  return JSON.stringify(value);
}

function decodePointerValue(raw: string): PointerValue | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PointerValue>;
    if (typeof parsed.linkIdentifier === "string") {
      return { linkIdentifier: parsed.linkIdentifier };
    }
  } catch {
    // Malformed value: treated as no pointer below.
  }
  return null;
}

/**
 * Delete whatever link (and its pointer) `userId` currently holds, if any: an
 * indexed lookup, not a table scan. Exported so the tenants feature's own
 * `addMember` can call it too: granting an existing, not-yet-signed-in
 * account a membership through that path must not leave an earlier
 * set-password link outstanding, or whoever holds its raw token could still
 * redeem it and inherit the membership just added (see
 * `redeemSetPasswordToken`'s `issuedByProviderAdmin` check below for the
 * other half of that defence).
 */
export async function invalidatePreviousLinks(db: DbExecutor, userId: string): Promise<void> {
  const [pointerRow] = await db
    .select({ id: verification.id, value: verification.value })
    .from(verification)
    .where(eq(verification.identifier, pointerIdentifierOf(userId)))
    .limit(1);
  if (!pointerRow) {
    return;
  }
  const idsToDelete = [pointerRow.id];
  const pointer = decodePointerValue(pointerRow.value);
  if (pointer) {
    const [linkRow] = await db
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.identifier, pointer.linkIdentifier))
      .limit(1);
    if (linkRow) {
      idsToDelete.push(linkRow.id);
    }
  }
  await db.delete(verification).where(inArray(verification.id, idsToDelete));
}

/**
 * Issue a fresh single-use link, invalidating whatever this user held before.
 * Invalidating the old link (and pointer) and inserting the new pair happen
 * in one transaction, so a concurrent reissue can never leave two links both
 * reading as valid, nor a pointer that outlives the link it points to.
 */
async function issueSetPasswordLink(
  db: Database,
  input: { userId: string; tenantId: string | null; issuedByProviderAdmin: boolean },
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const linkIdentifier = identifierOf(token);
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await db.transaction(async (tx) => {
    await invalidatePreviousLinks(tx, input.userId);
    await tx.insert(verification).values({
      id: randomUUID(),
      identifier: linkIdentifier,
      value: encodeLinkValue({
        userId: input.userId,
        tenantId: input.tenantId,
        used: false,
        issuedByProviderAdmin: input.issuedByProviderAdmin,
      }),
      expiresAt,
    });
    await tx.insert(verification).values({
      id: randomUUID(),
      identifier: pointerIdentifierOf(input.userId),
      value: encodePointerValue({ linkIdentifier }),
      expiresAt,
    });
  });
  return { token, expiresAt };
}

async function findLinkRow(db: Database, token: string) {
  const [row] = await db
    .select()
    .from(verification)
    .where(eq(verification.identifier, identifierOf(token)))
    .limit(1);
  return row ?? null;
}

/** "jane.doe@example.com" -> "j*******@example.com"; never the full address. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) {
    return "***";
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

export const setPasswordPath = (token: string): string =>
  `/accounts/set-password/${encodeURIComponent(token)}`;

/**
 * A set-password link for a new member of the provider team (ee/api
 * provider-team): the same single-use, 72h link as a tenant account's, bound
 * to no tenant. Redeeming it requires the person to still be a provider admin
 * with a team row by then; removing them from the team revokes it.
 */
export async function issueProviderInvitationLink(
  db: Database,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  return issueSetPasswordLink(db, { userId, tenantId: null, issuedByProviderAdmin: true });
}

/** Whether `userId` holds a set-password link that is not redeemed and not expired. */
export async function hasOpenSetPasswordLink(
  db: DbExecutor,
  userId: string,
  now: Date = new Date(),
): Promise<{ open: boolean; expiresAt: Date | null }> {
  const [pointerRow] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(eq(verification.identifier, pointerIdentifierOf(userId)))
    .limit(1);
  const pointer = pointerRow ? decodePointerValue(pointerRow.value) : null;
  if (!pointer) {
    return { open: false, expiresAt: null };
  }
  const [linkRow] = await db
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, pointer.linkIdentifier))
    .limit(1);
  const link = linkRow ? decodeLinkValue(linkRow.value) : null;
  if (!linkRow || !link || link.used) {
    return { open: false, expiresAt: null };
  }
  return { open: linkRow.expiresAt.getTime() > now.getTime(), expiresAt: linkRow.expiresAt };
}

// --- Credential password (mirrors apps/api/src/lib/first-admin.ts) -----------------

/** An id the way better-auth would generate it (its configured generator), else a UUID. */
async function newId(model: "account"): Promise<string> {
  const context = await auth.$context;
  return context.generateId({ model }) || randomUUID();
}

/**
 * Write the account's `credential` password. Insert-only: an account that
 * already has one is never overwritten (that would be a silent takeover of
 * whatever password its owner set). `provisionAccount` and
 * `reissueAccountLink` never issue a link for an account with an existing
 * credential in the first place, so this should be unreachable in practice;
 * it stays as the last line of defense against redeeming the same link twice
 * for two different passwords.
 */
async function setCredentialPassword(
  db: DbExecutor,
  userId: string,
  password: string,
): Promise<void> {
  const context = await auth.$context;
  const [existing] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .limit(1);
  if (existing) {
    throw linkProblem("used");
  }
  const hashed = await context.password.hash(password);
  await db.insert(account).values({
    id: await newId("account"),
    accountId: userId,
    providerId: "credential",
    userId,
    password: hashed,
  });
}

// --- Provision ------------------------------------------------------------------------

export async function provisionAccount(
  db: Database,
  tenant: Pick<TenantContext, "id" | "name" | "organizationId" | "status">,
  input: ProvisionAccountInput,
  actor: Actor,
  language: SupportedLanguage,
): Promise<ProvisionResult> {
  const organizationId = requireOrganization(tenant);
  const email = input.email.trim().toLowerCase();
  const name = input.name?.trim() || email;
  const memberRole = membershipRoleFromTenantRole(input.role);

  const [existing] = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  let userId: string;
  let created: boolean;
  let alreadySignedIn = false;
  if (existing) {
    if (isProviderAdminRole(existing.role)) {
      throw providerAdminTargetProblem();
    }
    if (!actor.isProviderAdmin && (await belongsToOtherTenant(db, existing.id, organizationId))) {
      throw crossTenantTargetProblem();
    }
    userId = existing.id;
    created = false;
    alreadySignedIn = await hasSignInMethod(db, userId);
  } else {
    const result = await authCall(() => auth.api.createUser({ body: { email, name } }));
    userId = result.user.id;
    created = true;
  }

  // The role actually in effect once this call returns: the chosen role for
  // a brand new membership, or the membership's existing, unchanged role
  // when the person was already a member of this tenant (below). Provisioning
  // never silently changes an existing membership's role — that is the
  // members table's job — so the response and the audit entry must never
  // claim `input.role` took effect when it did not.
  let effectiveRole: TenantRole = input.role;
  const [alreadyMember] = await db
    .select({ id: member.id, role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  if (alreadyMember) {
    effectiveRole = tenantRoleFromMembership(alreadyMember.role);
  } else {
    await authCall(() =>
      auth.api.addMember({ body: { userId, organizationId, role: memberRole } }),
    );
  }

  if (alreadySignedIn) {
    // Same as the tenants feature's own `addMember` for an existing account:
    // only the membership changes. No link is issued, so there is nothing to
    // email or copy, and nothing an attacker could redeem to replace a
    // working password.
    await audit(db, {
      tenantId: tenant.id,
      actor: actor.email,
      actorUserId: actor.id,
      action: ACCOUNT_AUDIT_ACTIONS.provisioned,
      target: userId,
      targetType: "user",
      onBehalfOf: email,
      ip: actor.ip,
      details: {
        role: effectiveRole,
        created: false,
        reusedExistingAccount: true,
        linkIssued: false,
      },
    });
    return {
      userId,
      email,
      name,
      role: effectiveRole,
      created: false,
      linkIssued: false,
      linkExpiresAt: null,
      setPasswordToken: null,
      mailOutcome: "not_configured",
    };
  }

  const link = await issueSetPasswordLink(db, {
    userId,
    tenantId: tenant.id,
    issuedByProviderAdmin: actor.isProviderAdmin,
  });

  await audit(db, {
    tenantId: tenant.id,
    actor: actor.email,
    actorUserId: actor.id,
    action: ACCOUNT_AUDIT_ACTIONS.provisioned,
    target: userId,
    targetType: "user",
    onBehalfOf: email,
    ip: actor.ip,
    details: { role: effectiveRole, created, reusedExistingAccount: !created, linkIssued: true },
  });
  await audit(db, {
    tenantId: tenant.id,
    actor: actor.email,
    actorUserId: actor.id,
    action: ACCOUNT_AUDIT_ACTIONS.linkIssued,
    target: userId,
    targetType: "user",
    onBehalfOf: email,
    ip: actor.ip,
  });

  const mailOutcome = await tryEmailLink(db, {
    email,
    name,
    tenantName: tenant.name,
    token: link.token,
    expiresAt: link.expiresAt,
    language,
  });

  return {
    userId,
    email,
    name,
    role: effectiveRole,
    created,
    linkIssued: true,
    linkExpiresAt: link.expiresAt.toISOString(),
    setPasswordToken: revealSetPasswordToken(mailOutcome, link.token),
    mailOutcome,
  };
}

/** Regenerate the link for an existing, genuinely pending member ("Resend" / "Copy new link"). */
export async function reissueAccountLink(
  db: Database,
  tenant: Pick<TenantContext, "id" | "name" | "organizationId" | "status">,
  userId: string,
  actor: Actor,
  language: SupportedLanguage,
): Promise<ProvisionResult> {
  const organizationId = requireOrganization(tenant);
  const [row] = await db
    .select({ email: user.email, name: user.name, role: member.role, userRole: user.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Member not found");
  }
  if (isProviderAdminRole(row.userRole)) {
    throw providerAdminTargetProblem();
  }
  // Same guard `provisionAccount` applies when the account is first added:
  // a person can be a pending member of more than one tenant at once (a
  // provider admin may add them to several), and a tenant admin must never
  // be able to fish the raw token for a membership that is not theirs out of
  // this endpoint just because the person also happens to be pending here.
  if (!actor.isProviderAdmin && (await belongsToOtherTenant(db, userId, organizationId))) {
    throw crossTenantTargetProblem();
  }
  if (await hasSignInMethod(db, userId)) {
    throw notPendingProblem();
  }

  const link = await issueSetPasswordLink(db, {
    userId,
    tenantId: tenant.id,
    issuedByProviderAdmin: actor.isProviderAdmin,
  });
  await audit(db, {
    tenantId: tenant.id,
    actor: actor.email,
    actorUserId: actor.id,
    action: ACCOUNT_AUDIT_ACTIONS.linkIssued,
    target: userId,
    targetType: "user",
    onBehalfOf: row.email,
    ip: actor.ip,
    details: { reissued: true },
  });

  const mailOutcome = await tryEmailLink(db, {
    email: row.email,
    name: row.name,
    tenantName: tenant.name,
    token: link.token,
    expiresAt: link.expiresAt,
    language,
  });

  return {
    userId,
    email: row.email,
    name: row.name,
    role: tenantRoleFromMembership(row.role),
    created: false,
    linkIssued: true,
    linkExpiresAt: link.expiresAt.toISOString(),
    setPasswordToken: revealSetPasswordToken(mailOutcome, link.token),
    mailOutcome,
  };
}

/**
 * Members of the tenant provisioned through this feature that have not set a
 * password, linked Microsoft sign-in or registered a passkey yet — never a
 * member who already signs in some other way (Entra SSO, an existing
 * passkey), so this list only ever shows accounts a "Copy new link" /
 * "Resend" button can actually help. Bounded rather than paginated: a
 * genuinely pending list stays small in practice (it shrinks the moment
 * someone redeems their link), unlike the full member list.
 */
export async function listPendingAccounts(
  db: Database,
  tenant: Pick<TenantContext, "organizationId">,
  options: { limit?: number } = {},
): Promise<PendingAccountDto[]> {
  if (!tenant.organizationId) {
    return [];
  }
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PENDING_LIMIT, 1), MAX_PENDING_LIMIT);
  const rows = await db
    .select({
      userId: member.userId,
      name: user.name,
      email: user.email,
      role: member.role,
      joinedAt: member.createdAt,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(account, eq(account.userId, member.userId))
    .leftJoin(passkey, eq(passkey.userId, member.userId))
    .where(
      and(eq(member.organizationId, tenant.organizationId), isNull(account.id), isNull(passkey.id)),
    )
    .orderBy(desc(member.createdAt))
    .limit(limit);
  if (rows.length === 0) {
    return [];
  }

  // One indexed lookup for exactly these users' pointer rows (see
  // invalidatePreviousLinks), instead of decoding every set-password row this
  // installation has ever written. A person with a credential already (their
  // link redeemed) was excluded from `rows` above, so "used" never surfaces
  // here — only "valid", "expired", or "invalid" for someone whose pointer
  // is missing entirely (provisioned before this scheme, or otherwise stale).
  const pointerRows = await db
    .select({ identifier: verification.identifier, expiresAt: verification.expiresAt })
    .from(verification)
    .where(
      inArray(
        verification.identifier,
        rows.map((row) => pointerIdentifierOf(row.userId)),
      ),
    );
  const now = Date.now();
  const statusByUser = new Map<string, { status: LinkStatus; expiresAt: Date }>();
  for (const row of pointerRows) {
    const userId = row.identifier.slice(POINTER_PREFIX.length);
    const status: LinkStatus = row.expiresAt.getTime() <= now ? "expired" : "valid";
    statusByUser.set(userId, { status, expiresAt: row.expiresAt });
  }

  return rows.map((row) => {
    const link = statusByUser.get(row.userId);
    return {
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: tenantRoleFromMembership(row.role),
      invitedAt: row.joinedAt.toISOString(),
      linkStatus: link?.status ?? "invalid",
      linkExpiresAt: link ? link.expiresAt.toISOString() : null,
    };
  });
}

// --- The public set-password exchange -----------------------------------------------

function linkProblem(status: Exclude<LinkStatus, "valid">): ProblemError {
  const detail =
    status === "used"
      ? "This link has already been used. Ask an administrator for a new one."
      : status === "expired"
        ? "This link has expired. Ask an administrator for a new one."
        : "This link is not valid.";
  return new ProblemError(status === "invalid" ? 404 : 409, "Set-password link not usable", {
    type: `urn:restow:problem:account-link-${status}`,
    detail,
  });
}

export async function checkSetPasswordToken(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<LinkCheckResult> {
  const row = await findLinkRow(db, token);
  const link = row ? decodeLinkValue(row.value) : null;
  if (!row || !link) {
    return { status: "invalid", emailHint: null };
  }
  const [account_] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, link.userId))
    .limit(1);
  const emailHint = account_ ? maskEmail(account_.email) : null;
  if (link.used) {
    return { status: "used", emailHint };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { status: "expired", emailHint };
  }
  return { status: "valid", emailHint };
}

export async function redeemSetPasswordToken(
  db: Database,
  input: { token: string; password: string },
  actor: RedeemActor,
  now: Date = new Date(),
): Promise<RedeemResult> {
  const row = await findLinkRow(db, input.token);
  const link = row ? decodeLinkValue(row.value) : null;
  if (!row || !link) {
    throw linkProblem("invalid");
  }
  if (link.used) {
    throw linkProblem("used");
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw linkProblem("expired");
  }

  const [person] = await db
    .select({ id: user.id, email: user.email, banned: user.banned, role: user.role })
    .from(user)
    .where(eq(user.id, link.userId))
    .limit(1);
  if (!person || person.banned) {
    throw linkProblem("invalid");
  }

  if (link.tenantId === null) {
    return redeemProviderInvitation(db, { row, link, person, password: input.password }, actor);
  }
  const tenantId = link.tenantId;

  // Consume the link and write the password together, pinned to the tenant it
  // was issued for (the audit entry below needs that same pin; it is also
  // what makes the `tenants` row below visible at all — that table's RLS
  // policy isolates on its own id, packages/db/sql/rls.sql, so it is empty to
  // an unpinned session). The update is a compare-and-swap on the row's exact
  // stored value: two concurrent redeems of the same token both start from
  // the same "unused" value, but only the first UPDATE still matches it once
  // it runs — the loser affects zero rows and is told the link was already
  // used, instead of both writes landing and the second password silently
  // winning.
  return withTenantTx(db, tenantId, async (tx) => {
    // The membership this link was issued for might have been removed since
    // (or the tenant deleted outright): a person who no longer belongs to the
    // tenant must never be able to set a password on an account that no
    // longer reaches it. `member` carries no RLS of its own (better-auth's
    // own tables have none), so this join is exactly the rows the pinned
    // `tenants` row (if any) and this person's memberships produce.
    const [membership] = await tx
      .select({ id: member.id, organizationId: member.organizationId })
      .from(member)
      .innerJoin(tenants, eq(tenants.organizationId, member.organizationId))
      .where(and(eq(tenants.id, tenantId), eq(member.userId, person.id)))
      .limit(1);
    if (!membership) {
      throw linkProblem("invalid");
    }
    // A tenant admin's link must not still work once the person has picked
    // up a membership in some other tenant by the time it is redeemed — by
    // any path, not only the ones this feature itself guards against — or a
    // tenant admin could hold a link open on an address until it becomes (or
    // turns out already to be) someone else's account elsewhere, then redeem
    // it and inherit that membership too. Only a provider admin's own link,
    // who may legitimately add one person to several tenants, is exempt.
    if (
      !link.issuedByProviderAdmin &&
      (await belongsToOtherTenant(tx, person.id, membership.organizationId))
    ) {
      throw linkProblem("invalid");
    }

    const claimed = await tx
      .update(verification)
      .set({ value: encodeLinkValue({ ...link, used: true }) })
      .where(and(eq(verification.id, row.id), eq(verification.value, row.value)))
      .returning({ id: verification.id });
    if (claimed.length === 0) {
      throw linkProblem("used");
    }

    await setCredentialPassword(tx, person.id, input.password);

    await audit(tx, {
      tenantId,
      actor: person.email,
      actorUserId: person.id,
      action: ACCOUNT_AUDIT_ACTIONS.passwordSet,
      target: person.id,
      targetType: "user",
      ip: actor.ip,
    });

    return { userId: person.id, email: person.email };
  });
}

/**
 * Redeem a provider team invitation: only while the person is still a
 * provider admin with a team row (removing them from the team, or taking the
 * admin role away, makes the link useless). The team tables belong to the
 * installation role (packages/db roles.ts), so that check runs on its pool;
 * the link and the password live in better-auth's own tables.
 */
async function redeemProviderInvitation(
  db: Database,
  input: {
    row: { id: string; value: string };
    link: LinkValue;
    person: { id: string; email: string; role: string | null };
    password: string;
  },
  actor: RedeemActor,
): Promise<RedeemResult> {
  const [teamRow] = await providerDb
    .select({ userId: providerMembers.userId })
    .from(providerMembers)
    .where(eq(providerMembers.userId, input.person.id))
    .limit(1);
  if (!teamRow || !isProviderAdminRole(input.person.role)) {
    throw linkProblem("invalid");
  }
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(verification)
      .set({ value: encodeLinkValue({ ...input.link, used: true }) })
      .where(and(eq(verification.id, input.row.id), eq(verification.value, input.row.value)))
      .returning({ id: verification.id });
    if (claimed.length === 0) {
      throw linkProblem("used");
    }
    await setCredentialPassword(tx, input.person.id, input.password);
  });
  await audit(providerDb, {
    tenantId: null,
    actor: input.person.email,
    actorUserId: input.person.id,
    action: ACCOUNT_AUDIT_ACTIONS.passwordSet,
    target: input.person.id,
    targetType: "user",
    ip: actor.ip,
  });
  return { userId: input.person.id, email: input.person.email };
}

/**
 * Whether the raw set-password token may be handed back to the admin who
 * called this API: only when it could not also be mailed straight to the
 * account's own address. Once that delivery actually succeeds, the person who
 * owns the address is the only one who received a usable link — giving the
 * admin a copy of it too would let them redeem it themselves and quietly
 * become that person for self-service purposes (their onward reads and
 * restores would read as the owner acting on their own data, not as
 * impersonation). When mail is not configured or delivery fails, the admin
 * still needs a way to hand the link over through some other channel, so the
 * token is returned as it always was.
 */
export function revealSetPasswordToken(mailOutcome: MailOutcome, token: string): string | null {
  return mailOutcome === "sent" ? null : token;
}

// --- Best-effort mail (the admin can always copy the link instead) -----------------

async function publicBaseUrl(db: Database): Promise<string | null> {
  const [row] = await db.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
  return row?.publicUrl ?? config.publicUrl ?? null;
}

function absoluteSetPasswordUrl(base: string | null, token: string): string {
  const path = setPasswordPath(token);
  return base ? `${base.replace(/\/+$/, "")}${path}` : path;
}

/**
 * Mail a provider team invitation link (best effort, like a tenant account's:
 * the owner can always copy the link instead when this fails).
 */
export async function emailProviderInvitation(
  db: Database,
  input: { email: string; token: string; language: SupportedLanguage },
): Promise<MailOutcome> {
  let notifier: Notifier | null;
  try {
    notifier = await createInstallationNotifier(db);
  } catch {
    return "failed";
  }
  if (!notifier) {
    return "not_configured";
  }
  try {
    const url = absoluteSetPasswordUrl(await publicBaseUrl(db), input.token);
    const i18n = createI18n({ lng: input.language });
    const subject = String(i18n.t("accounts:mail.providerSubject"));
    const text = String(i18n.t("accounts:mail.providerBody", { url, hours: 72 }));
    const result = await notifier.send({ to: input.email, subject, text });
    return result.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

async function tryEmailLink(
  db: Database,
  input: {
    email: string;
    name: string;
    tenantName: string;
    token: string;
    expiresAt: Date;
    language: SupportedLanguage;
  },
): Promise<MailOutcome> {
  let notifier: Notifier | null;
  try {
    // The installation's configured transport (Settings → Mail), shared with
    // every other feature that sends notifications: SMTP or Microsoft Graph,
    // resolved with its stored credentials. `null` means none is configured.
    notifier = await createInstallationNotifier(db);
  } catch {
    return "failed";
  }
  if (!notifier) {
    return "not_configured";
  }
  try {
    const base = await publicBaseUrl(db);
    const url = absoluteSetPasswordUrl(base, input.token);
    const i18n = createI18n({ lng: input.language });
    const subject = String(i18n.t("accounts:mail.subject", { tenant: input.tenantName }));
    const text = String(i18n.t("accounts:mail.body", { tenant: input.tenantName, url, hours: 72 }));
    const result = await notifier.send({ to: input.email, subject, text });
    return result.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
