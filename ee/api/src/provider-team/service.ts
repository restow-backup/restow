import { randomUUID } from "node:crypto";
import {
  type Database,
  member,
  providerMemberTenants,
  providerMembers,
  session,
  tenants,
  user,
} from "@restow/db";
import { eq, inArray, like, sql } from "drizzle-orm";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { auth } from "../../../../apps/api/src/auth.js";
import {
  type MailOutcome,
  emailProviderInvitation,
  hasOpenSetPasswordLink,
  hasSignInMethod,
  invalidatePreviousLinks,
  issueProviderInvitationLink,
  revealSetPasswordToken,
} from "../../../../apps/api/src/features/accounts/service.js";
import { audit } from "../../../../apps/api/src/lib/audit.js";
import type { requestLanguage } from "../../../../apps/api/src/lib/language.js";
import type { ProviderRole } from "../../../../apps/api/src/lib/provider-access.js";
import type { DbExecutor } from "../../../../apps/api/src/lib/tenant-context.js";
import {
  PROVIDER_ADMIN_USER_ROLE,
  isProviderAdminRole,
} from "../../../../apps/api/src/middleware/rbac.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import type { InviteMemberInput, UpdateMemberInput } from "./schemas.js";

type SupportedLanguage = ReturnType<typeof requestLanguage>;

/**
 * The provider team (Business and Service Provider, capability `provider.team`):
 * several provider admins, each with a role and a tenant scope
 * (apps/api lib/provider-access.ts decides what each may do).
 *
 * A provider admin is a better-auth user whose `role` is `admin`; the team
 * row narrows that down. A provider admin without a row is an owner with
 * every tenant: the setup wizard's first admin, and every installation from
 * before the team. So a new member is created together with their row in
 * one transaction, never as a bare admin that would read as an owner.
 *
 * Every change keeps at least one owner, and is recorded in the
 * installation's audit log. The team tables are the installation role's
 * alone (packages/db roles.ts), so everything here runs on `providerDb`;
 * set-password links live in better-auth's `verification` table.
 */

export const TEAM_AUDIT_ACTIONS = {
  invited: "provider_team.member_invited",
  updated: "provider_team.member_updated",
  removed: "provider_team.member_removed",
  linkReissued: "provider_team.link_reissued",
} as const;

export interface TeamActor {
  userId: string;
  email: string;
  ip: string | null;
}

export type MemberStatus = "active" | "invited" | "invitation_expired";

export interface TeamMemberDto {
  userId: string;
  name: string;
  email: string;
  role: ProviderRole;
  allTenants: boolean;
  tenantIds: string[];
  status: MemberStatus;
  /** The signed-in person themself. */
  isYou: boolean;
  addedAt: string;
}

export interface InvitationResult {
  member: TeamMemberDto;
  /** Only when the link could not be mailed to the member (the owner hands it over). */
  setPasswordToken: string | null;
  linkExpiresAt: string;
  mailOutcome: MailOutcome;
}

export interface TeamDeps {
  /** The installation pool: the team tables, users, sessions. */
  providerDb: Database;
  /** The application pool, for set-password links (better-auth's own tables). */
  db: Database;
}

function problem(
  status: ContentfulStatusCode,
  type: string,
  title: string,
  detail: string,
): ProblemError {
  return new ProblemError(status, title, { type: `urn:restow:problem:${type}`, detail });
}

/**
 * Team changes run one at a time: two owners demoting each other at once
 * must not both succeed and leave no owner behind.
 */
const TEAM_LOCK = sql`select pg_advisory_xact_lock(hashtext('restow:provider-team'))`;

const lastOwnerProblem = () =>
  problem(
    409,
    "provider-team-last-owner",
    "The last owner stays",
    "The provider team always keeps at least one owner. Make someone else an owner first.",
  );

const notAMemberProblem = () =>
  problem(
    404,
    "provider-team-member-not-found",
    "Not a team member",
    "No provider admin has this id.",
  );

interface AdminRow {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  teamRole: ProviderRole | null;
  allTenants: boolean | null;
  addedAt: Date | null;
}

/** Every provider admin, with their team row when they have one. */
async function loadAdmins(executor: DbExecutor): Promise<AdminRow[]> {
  const rows = await executor
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      teamRole: providerMembers.role,
      allTenants: providerMembers.allTenants,
      addedAt: providerMembers.createdAt,
    })
    .from(user)
    .leftJoin(providerMembers, eq(providerMembers.userId, user.id))
    .where(like(user.role, `%${PROVIDER_ADMIN_USER_ROLE}%`));
  return rows
    .filter((row) => isProviderAdminRole(row.role))
    .map(({ role: _role, ...rest }) => rest);
}

/** A row's effective role: no team row means an owner (see the module comment). */
const effectiveRole = (row: Pick<AdminRow, "teamRole">): ProviderRole => row.teamRole ?? "owner";

function ownerCount(admins: readonly AdminRow[]): number {
  return admins.filter((row) => effectiveRole(row) === "owner").length;
}

/** An owner always covers every tenant; everyone else needs at least one. */
function normalizeScope(input: {
  role: ProviderRole;
  allTenants: boolean;
  tenantIds: string[];
}): { allTenants: boolean; tenantIds: string[] } {
  if (input.role === "owner" || input.allTenants) {
    return { allTenants: true, tenantIds: [] };
  }
  const tenantIds = [...new Set(input.tenantIds)];
  if (tenantIds.length === 0) {
    throw problem(
      422,
      "provider-team-no-tenants",
      "No tenant chosen",
      "Choose at least one tenant, or give the member every tenant.",
    );
  }
  return { allTenants: false, tenantIds };
}

async function assertTenantsExist(providerDb: Database, tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) {
    return;
  }
  const found = await providerDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(inArray(tenants.id, tenantIds));
  if (found.length !== tenantIds.length) {
    throw problem(
      422,
      "provider-team-unknown-tenant",
      "Unknown tenant",
      "One of the chosen tenants does not exist.",
    );
  }
}

async function statusOf(db: Database, userId: string): Promise<MemberStatus> {
  if (await hasSignInMethod(db, userId)) {
    return "active";
  }
  const link = await hasOpenSetPasswordLink(db, userId);
  return link.open ? "invited" : "invitation_expired";
}

async function toDto(
  deps: TeamDeps,
  row: AdminRow,
  scopes: ReadonlyMap<string, string[]>,
  currentUserId: string,
): Promise<TeamMemberDto> {
  const role = effectiveRole(row);
  const allTenants = role === "owner" || (row.allTenants ?? true);
  return {
    userId: row.id,
    name: row.name,
    email: row.email,
    role,
    allTenants,
    tenantIds: allTenants ? [] : [...(scopes.get(row.id) ?? [])].sort(),
    status: await statusOf(deps.db, row.id),
    isYou: row.id === currentUserId,
    addedAt: (row.addedAt ?? row.createdAt).toISOString(),
  };
}

async function scopesOf(providerDb: Database, userIds: string[]): Promise<Map<string, string[]>> {
  const scopes = new Map<string, string[]>();
  if (userIds.length === 0) {
    return scopes;
  }
  const rows = await providerDb
    .select({ userId: providerMemberTenants.userId, tenantId: providerMemberTenants.tenantId })
    .from(providerMemberTenants)
    .where(inArray(providerMemberTenants.userId, userIds));
  for (const row of rows) {
    scopes.set(row.userId, [...(scopes.get(row.userId) ?? []), row.tenantId]);
  }
  return scopes;
}

export async function listTeam(deps: TeamDeps, currentUserId: string): Promise<TeamMemberDto[]> {
  const admins = await loadAdmins(deps.providerDb);
  const scopes = await scopesOf(
    deps.providerDb,
    admins.map((row) => row.id),
  );
  const members = await Promise.all(admins.map((row) => toDto(deps, row, scopes, currentUserId)));
  const order: Record<ProviderRole, number> = {
    owner: 0,
    administrator: 1,
    technician: 2,
    read_only: 3,
  };
  return members.sort(
    (a, b) =>
      order[a.role] - order[b.role] ||
      a.name.localeCompare(b.name) ||
      a.email.localeCompare(b.email),
  );
}

async function memberDto(
  deps: TeamDeps,
  userId: string,
  currentUserId: string,
): Promise<TeamMemberDto> {
  const admins = await loadAdmins(deps.providerDb);
  const row = admins.find((admin) => admin.id === userId);
  if (!row) {
    throw notAMemberProblem();
  }
  return toDto(deps, row, await scopesOf(deps.providerDb, [userId]), currentUserId);
}

async function sendInvitation(
  deps: TeamDeps,
  userId: string,
  email: string,
  language: SupportedLanguage,
): Promise<{ token: string | null; expiresAt: Date; mailOutcome: MailOutcome }> {
  const { token, expiresAt } = await issueProviderInvitationLink(deps.db, userId);
  const mailOutcome = await emailProviderInvitation(deps.db, { email, token, language });
  return { token: revealSetPasswordToken(mailOutcome, token), expiresAt, mailOutcome };
}

/**
 * Invite a new provider admin: a fresh account (never an existing one, which
 * could belong to a tenant's own people), created with its team row in one
 * transaction, then a set-password link to the address.
 */
export async function inviteMember(
  deps: TeamDeps,
  input: InviteMemberInput,
  actor: TeamActor,
  language: SupportedLanguage,
): Promise<InvitationResult> {
  const scope = normalizeScope(input);
  await assertTenantsExist(deps.providerDb, scope.tenantIds);
  const [existing] = await deps.providerDb
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, input.email))
    .limit(1);
  if (existing) {
    throw problem(
      409,
      "provider-team-account-exists",
      "Address already in use",
      "An account with this address already exists. Invite the person with a different address.",
    );
  }

  const context = await auth.$context;
  const userId = context.generateId({ model: "user" }) || randomUUID();
  await deps.providerDb.transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name: input.name,
      email: input.email,
      emailVerified: false,
      role: PROVIDER_ADMIN_USER_ROLE,
    });
    await tx.insert(providerMembers).values({
      userId,
      role: input.role,
      allTenants: scope.allTenants,
      invitedBy: actor.userId,
    });
    if (scope.tenantIds.length > 0) {
      await tx
        .insert(providerMemberTenants)
        .values(scope.tenantIds.map((tenantId) => ({ userId, tenantId })));
    }
    await audit(tx, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.userId,
      action: TEAM_AUDIT_ACTIONS.invited,
      target: userId,
      targetType: "user",
      ip: actor.ip,
      details: {
        email: input.email,
        role: input.role,
        allTenants: scope.allTenants,
        tenantCount: scope.tenantIds.length,
      },
    });
  });

  const invitation = await sendInvitation(deps, userId, input.email, language);
  return {
    member: await memberDto(deps, userId, actor.userId),
    setPasswordToken: invitation.token,
    linkExpiresAt: invitation.expiresAt.toISOString(),
    mailOutcome: invitation.mailOutcome,
  };
}

/** Change a member's role and tenants; the last owner stays an owner. */
export async function updateMember(
  deps: TeamDeps,
  userId: string,
  input: UpdateMemberInput,
  actor: TeamActor,
): Promise<TeamMemberDto> {
  const scope = normalizeScope(input);
  await assertTenantsExist(deps.providerDb, scope.tenantIds);
  await deps.providerDb.transaction(async (tx) => {
    await tx.execute(TEAM_LOCK);
    const admins = await loadAdmins(tx);
    const target = admins.find((row) => row.id === userId);
    if (!target) {
      throw notAMemberProblem();
    }
    const before = effectiveRole(target);
    if (before === "owner" && input.role !== "owner" && ownerCount(admins) <= 1) {
      throw lastOwnerProblem();
    }
    await tx
      .insert(providerMembers)
      .values({ userId, role: input.role, allTenants: scope.allTenants })
      .onConflictDoUpdate({
        target: providerMembers.userId,
        set: { role: input.role, allTenants: scope.allTenants, updatedAt: new Date() },
      });
    await tx.delete(providerMemberTenants).where(eq(providerMemberTenants.userId, userId));
    if (scope.tenantIds.length > 0) {
      await tx
        .insert(providerMemberTenants)
        .values(scope.tenantIds.map((tenantId) => ({ userId, tenantId })));
    }
    await audit(tx, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.userId,
      action: TEAM_AUDIT_ACTIONS.updated,
      target: userId,
      targetType: "user",
      ip: actor.ip,
      details: {
        roleBefore: before,
        role: input.role,
        allTenants: scope.allTenants,
        tenantCount: scope.tenantIds.length,
      },
    });
  });
  return memberDto(deps, userId, actor.userId);
}

/**
 * Remove a member from the team: no admin role, no team row, no open
 * set-password link, no session. An account that belongs to no tenant
 * either is deleted outright (its passkeys and passwords with it); one that
 * does keeps only those tenant memberships.
 */
export async function removeMember(
  deps: TeamDeps,
  userId: string,
  actor: TeamActor,
): Promise<void> {
  await deps.providerDb.transaction(async (tx) => {
    await tx.execute(TEAM_LOCK);
    const admins = await loadAdmins(tx);
    const target = admins.find((row) => row.id === userId);
    if (!target) {
      throw notAMemberProblem();
    }
    if (effectiveRole(target) === "owner" && ownerCount(admins) <= 1) {
      throw lastOwnerProblem();
    }
    await invalidatePreviousLinks(tx, userId);
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(providerMembers).where(eq(providerMembers.userId, userId));
    const [membership] = await tx
      .select({ id: member.id })
      .from(member)
      .where(eq(member.userId, userId))
      .limit(1);
    if (membership) {
      await tx.update(user).set({ role: "user", updatedAt: new Date() }).where(eq(user.id, userId));
    } else {
      await tx.delete(user).where(eq(user.id, userId));
    }
    await audit(tx, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.userId,
      action: TEAM_AUDIT_ACTIONS.removed,
      target: userId,
      targetType: "user",
      ip: actor.ip,
      details: { email: target.email, role: effectiveRole(target), accountDeleted: !membership },
    });
  });
}

/** A fresh invitation link for a member who has not signed in yet. */
export async function reissueInvitation(
  deps: TeamDeps,
  userId: string,
  actor: TeamActor,
  language: SupportedLanguage,
): Promise<InvitationResult> {
  const current = await memberDto(deps, userId, actor.userId);
  if (current.status === "active") {
    throw problem(
      409,
      "provider-team-already-active",
      "Already signed in",
      "This member already has a way to sign in; a new link is not needed.",
    );
  }
  const invitation = await sendInvitation(deps, userId, current.email, language);
  await audit(deps.providerDb, {
    tenantId: null,
    actor: actor.email,
    actorUserId: actor.userId,
    action: TEAM_AUDIT_ACTIONS.linkReissued,
    target: userId,
    targetType: "user",
    ip: actor.ip,
  });
  return {
    member: await memberDto(deps, userId, actor.userId),
    setPasswordToken: invitation.token,
    linkExpiresAt: invitation.expiresAt.toISOString(),
    mailOutcome: invitation.mailOutcome,
  };
}
