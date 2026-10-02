import type { BadgeProps } from "@/components/ui/badge";
import { ApiError, type TenantRole, errorMessageKey, isFeatureUnavailable } from "@/lib/api";

import type { MailTestFailureReason } from "./api";
import type { Readiness, TenantHealth, TenantItem, TenantStatus, UsageOverview } from "./types";

/**
 * Pure presentation rules for tenant management: whether another tenant may
 * be created, badges, mailbox usage, search and the translation of API
 * failures. Every `key` is namespaced, so components call
 * `t(message.key, message.values)` from any namespace.
 */

export interface Message {
  key: string;
  values?: Record<string, unknown>;
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

// --- Creating tenants -----------------------------------------------------------

/**
 * Whether another tenant may be created. The first tenant always may; every
 * further one needs the gated feature `tenants.additional` (lib/api.ts), which
 * the API checks the same way. Tenants being deleted still count, exactly as
 * the API counts them.
 */
export function canCreateTenant(input: {
  tenantCount: number;
  additionalTenants: boolean;
}): boolean {
  return input.tenantCount === 0 || input.additionalTenants;
}

/** "12 mailboxes protected" for the installation. */
export function installationUsage(usage: UsageOverview): Message {
  return { key: "tenants:overview.usage", values: { count: usage.usedMailboxes } };
}

export interface MailboxUsage {
  /** Protected mailboxes in the tenant; null when unknown. */
  used: number | null;
  /** The cap the provider agreed with the customer; null = none. Never enforced. */
  cap: number | null;
  /** The tenant protects more mailboxes than the agreed cap. */
  overCap: boolean;
}

export function mailboxUsage(
  tenant: Pick<TenantItem, "id" | "mailboxCap">,
  usage: UsageOverview | undefined,
): MailboxUsage {
  const used = usage ? (usage.mailboxesByTenant[tenant.id] ?? 0) : null;
  return {
    used,
    cap: tenant.mailboxCap,
    overCap: used !== null && tenant.mailboxCap !== null && used > tenant.mailboxCap,
  };
}

// --- The operator's own organisation ----------------------------------------------

/** A tenant the operator may mark as the own organisation. */
export interface OwnOrganisationChoice {
  id: string;
  name: string;
  customerNumber: string | null;
}

/**
 * What the dashboard asks a provider admin about the own organisation:
 *
 *   - `setUp`        the installation has none yet. It can be created when no
 *                    tenant exists or the installation may have several (the API
 *                    applies the same limit to every tenant), and any tenant that
 *                    is not being deleted can be marked as it.
 *   - `addCustomer`  the own organisation exists on an installation that may have
 *                    several tenants, and it has no customer yet.
 *
 * `null` asks nothing. Only provider admins are asked; the actions are for
 * those whose team role may use them (`canManage`), the others see the note.
 */
export type OwnOrganisationPrompt =
  | { kind: "setUp"; canManage: boolean; canCreate: boolean; existing: OwnOrganisationChoice[] }
  | { kind: "addCustomer" };

export function ownOrganisationPrompt(input: {
  tenants: readonly Pick<TenantItem, "id" | "name" | "kind" | "status" | "customerNumber">[];
  providerAdmin: boolean;
  /** The provider team role may create tenants and mark one (administrator with every tenant). */
  canManage: boolean;
  /** The installation may have more than one tenant (`tenants.additional`). */
  additionalTenants: boolean;
}): OwnOrganisationPrompt | null {
  if (!input.providerAdmin) {
    return null;
  }
  const live = input.tenants.filter((tenant) => tenant.status !== "deleting");
  if (!input.tenants.some((tenant) => tenant.kind === "internal")) {
    const canCreate = input.tenants.length === 0 || input.additionalTenants;
    const existing = live.map(({ id, name, customerNumber }) => ({ id, name, customerNumber }));
    // Nothing to offer: no tenant to mark, and none may be created.
    if (!canCreate && existing.length === 0) {
      return null;
    }
    return { kind: "setUp", canManage: input.canManage, canCreate, existing };
  }
  const hasCustomer = live.some((tenant) => tenant.kind === "customer");
  return input.additionalTenants && input.canManage && !hasCustomer
    ? { kind: "addCustomer" }
    : null;
}

// --- Badges ---------------------------------------------------------------------

/** A backup without a verified restore counts as failed, so "not ready" looks like one. */
const READINESS_BADGE: Record<Readiness, BadgeVariant> = {
  green: "success",
  yellow: "warning",
  red: "destructive",
};

export function readinessBadge(readiness: Readiness | null): {
  variant: BadgeVariant;
  labelKey: string;
} {
  if (readiness === null) {
    return { variant: "muted", labelKey: "tenants:readiness.none" };
  }
  return { variant: READINESS_BADGE[readiness], labelKey: `tenants:readiness.${readiness}` };
}

// An active tenant is a state, shown as the neutral outline; green is for the readiness above.
const STATUS_BADGE: Record<TenantStatus, BadgeVariant> = {
  active: "outline",
  suspended: "warning",
  deleting: "destructive",
};

export function statusBadge(status: TenantStatus): { variant: BadgeVariant; labelKey: string } {
  return { variant: STATUS_BADGE[status], labelKey: `tenants:status.${status}` };
}

/** One line under the readiness badge: what is wrong, or when it was last proven. */
export function healthDetail(health: TenantHealth): Message {
  if (health.protectedObjects === 0) {
    return { key: "tenants:readiness.nothingProtected" };
  }
  if (health.notReady > 0) {
    return {
      key: "tenants:readiness.notReadyCount",
      values: { count: health.notReady, total: health.protectedObjects },
    };
  }
  return {
    key: "tenants:readiness.allReady",
    values: { count: health.protectedObjects },
  };
}

// --- Lists ----------------------------------------------------------------------

/** Case-insensitive match on name and slug; an empty query keeps everything. */
export function filterTenants<T extends Pick<TenantItem, "name" | "slug">>(
  tenants: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...tenants];
  }
  return tenants.filter(
    (tenant) =>
      tenant.name.toLowerCase().includes(needle) || tenant.slug.toLowerCase().includes(needle),
  );
}

/** A tenant that can still be worked in: not being deleted. */
export function canEnter(tenant: Pick<TenantItem, "status">): boolean {
  return tenant.status !== "deleting";
}

/**
 * The tenant to continue in after `removedId` was deleted: the first other
 * tenant that can still be entered, or null when none is left.
 */
export function fallbackTenant<T extends Pick<TenantItem, "id" | "status">>(
  tenants: readonly T[],
  removedId: string,
): T | null {
  return tenants.find((tenant) => tenant.id !== removedId && canEnter(tenant)) ?? null;
}

/** A pending invitation past its expiry cannot be accepted any more. */
export function isExpired(expiresAt: string | null, now: number): boolean {
  if (!expiresAt) {
    return false;
  }
  const time = Date.parse(expiresAt);
  return !Number.isNaN(time) && time <= now;
}

/** Suggested role for the next invitation: the first person should administer the tenant. */
export function suggestedRole(adminCount: number): "tenant_admin" | "tenant_user" {
  return adminCount === 0 ? "tenant_admin" : "tenant_user";
}

// --- API failures ---------------------------------------------------------------

const PROBLEM_TYPES = {
  slugTaken: "urn:restow:problem:slug-taken",
  setupRequired: "urn:restow:problem:setup-required",
  customerNumberTaken: "urn:restow:problem:customer-number-taken",
  internalTenantExists: "urn:restow:problem:internal-tenant-exists",
  internalTenantProtected: "urn:restow:problem:internal-tenant-protected",
} as const;

/** better-auth codes the API passes through (`code` extension) that mean "slug in use". */
const SLUG_CONFLICT_CODES = new Set([
  "ORGANIZATION_ALREADY_EXISTS",
  "ORGANIZATION_SLUG_ALREADY_TAKEN",
]);

function problemOf(error: unknown) {
  return error instanceof ApiError ? error.problem : null;
}

/** The shared fallback: `common:errors.*` for the HTTP status. */
export function genericError(error: unknown): Message {
  return { key: `common:${errorMessageKey(error)}` };
}

/** Whether a create failure is about the slug (shown on the field, not as an alert). */
export function isSlugConflict(error: unknown): boolean {
  const problem = problemOf(error);
  if (!problem) {
    return false;
  }
  return (
    problem.type === PROBLEM_TYPES.slugTaken ||
    (typeof problem.code === "string" && SLUG_CONFLICT_CODES.has(problem.code))
  );
}

/** Whether a create or edit failure is about the customer number (shown on the field). */
export function isCustomerNumberConflict(error: unknown): boolean {
  return problemOf(error)?.type === PROBLEM_TYPES.customerNumberTaken;
}

/** Why creating a tenant failed, for the alert in the dialog. */
export function createTenantError(error: unknown): Message {
  const problem = problemOf(error);
  if (isFeatureUnavailable(error)) {
    return { key: "tenants:errors.featureUnavailable" };
  }
  if (problem?.type === PROBLEM_TYPES.setupRequired) {
    return { key: "tenants:errors.setupRequired" };
  }
  if (isSlugConflict(error)) {
    return { key: "tenants:validation.slugTaken" };
  }
  if (isCustomerNumberConflict(error)) {
    return { key: "tenants:validation.customerNumberTaken" };
  }
  return genericError(error);
}

/** Why deleting a tenant failed: the own organisation has its own explanation. */
export function deleteTenantError(error: unknown): Message {
  if (problemOf(error)?.type === PROBLEM_TYPES.internalTenantProtected) {
    return { key: "tenants:errors.internalTenantProtected" };
  }
  return genericError(error);
}

/** Why creating the own organisation or marking a tenant as it failed. */
export function ownOrganisationError(error: unknown): Message {
  const problem = problemOf(error);
  if (isFeatureUnavailable(error)) {
    return { key: "tenants:ownOrganisation.errors.featureUnavailable" };
  }
  if (problem?.type === PROBLEM_TYPES.internalTenantExists) {
    return { key: "tenants:ownOrganisation.errors.exists" };
  }
  if (problem?.type === PROBLEM_TYPES.setupRequired) {
    return { key: "tenants:errors.setupRequired" };
  }
  if (isSlugConflict(error)) {
    return { key: "tenants:validation.slugTaken" };
  }
  return genericError(error);
}

/** Why adding a member or sending an invitation failed. */
export function addMemberError(error: unknown): Message {
  const problem = problemOf(error);
  if (error instanceof ApiError && error.status === 409 && problem) {
    if (problem.code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION") {
      return { key: "tenants:errors.alreadyMember" };
    }
    if (typeof problem.invitationId === "string") {
      return { key: "tenants:errors.alreadyInvited" };
    }
  }
  return genericError(error);
}

/** Why a member or invitation change failed (role, removal, cancellation). */
export function memberChangeError(error: unknown): Message {
  if (error instanceof ApiError && error.status === 404) {
    return { key: "tenants:errors.memberGone" };
  }
  return genericError(error);
}

// --- Invitations (better-auth organization endpoints) ----------------------------

export interface AuthFailure {
  status: number;
  code?: string;
}

/**
 * What an invitation lookup or answer failed with:
 * - `detailsHidden`   the invitation is valid and addressed to this account,
 *                     but better-auth withholds the details (it requires the
 *                     inviter to be a member; provider admins are not)
 * - `wrongRecipient`  addressed to a different email address
 * - `invalid`         accepted, declined, cancelled, expired or unknown
 * - `emailUnverified` better-auth wants a verified email first
 * - `failed`          anything else (network, server)
 */
export type InvitationFailure =
  | "detailsHidden"
  | "wrongRecipient"
  | "invalid"
  | "emailUnverified"
  | "failed";

/**
 * better-auth stores organization roles (`owner`, `admin`, `member`, possibly
 * comma-separated); owners and admins administer the tenant. Mirrors
 * `tenantRoleFromMembership` in apps/api/src/middleware/rbac.ts.
 */
export function tenantRoleFromMemberRole(memberRole: string | null | undefined): TenantRole {
  const roles = (memberRole ?? "").split(",").map((role) => role.trim().toLowerCase());
  return roles.some((role) => role === "owner" || role === "admin")
    ? "tenant_admin"
    : "tenant_user";
}

// --- Tenant wizard: notifications --------------------------------------------

/** Why the wizard's "Send test mail" failed once it ran, for the alert under the button. */
export function mailTestFailureKey(reason: MailTestFailureReason): string {
  switch (reason) {
    case "timeout":
      return "tenants:wizard.notifications.testMail.testFailure.timeout";
    case "graph_app_missing":
      return "tenants:wizard.notifications.testMail.testFailure.graphAppMissing";
    case "graph_tenant_missing":
      return "tenants:wizard.notifications.testMail.testFailure.graphTenantMissing";
    default:
      return "tenants:wizard.notifications.testMail.testFailure.transportError";
  }
}

/**
 * The problem type POST /settings/mail/test throws when no transport is
 * configured. Exported so `step-notifications.tsx` checks the same constant
 * instead of keeping its own copy.
 */
export const MAIL_NOT_CONFIGURED_PROBLEM = "urn:restow:problem:mail-not-configured";

/**
 * Why "Send test mail" could not even run (as opposed to running and failing,
 * which {@link mailTestFailureKey} explains from the response body): thrown
 * errors only, so an unconfigured transport, a forbidden request or a server
 * error are never silently swallowed.
 */
export function notificationTestErrorKey(error: unknown): Message {
  const problem = problemOf(error);
  if (problem?.type === MAIL_NOT_CONFIGURED_PROBLEM) {
    return { key: "tenants:wizard.notifications.testMail.notConfigured" };
  }
  return genericError(error);
}

// --- URL state: tenants list ------------------------------------------------

export interface TenantsSearch {
  /** Opens the "+ New tenant" wizard on arrival (e.g. from the command palette). */
  new?: true;
}

/** Accepts only `new=1`; anything else is dropped, same as every other search parser. */
export function parseTenantsSearch(search: unknown): TenantsSearch {
  const raw =
    typeof search === "object" && search !== null ? (search as Record<string, unknown>) : {};
  return raw.new === "1" || raw.new === true ? { new: true } : {};
}

export function invitationFailure(error: AuthFailure): InvitationFailure {
  switch (error.code) {
    case "INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION":
      return "detailsHidden";
    case "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION":
      return "wrongRecipient";
    case "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION":
    case "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION":
      return "emailUnverified";
    case "INVITATION_NOT_FOUND":
    case "ORGANIZATION_NOT_FOUND":
      return "invalid";
    default:
      // "Invitation not found!" comes without a code, as a plain 400.
      return error.status === 400 ? "invalid" : "failed";
  }
}
