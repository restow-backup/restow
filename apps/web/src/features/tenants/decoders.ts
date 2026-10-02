import { type TenantKind, type TenantRole, unwrapList } from "@/lib/api";

import { tenantRoleFromMemberRole } from "./presenters";
import {
  type AddMemberResult,
  type Invitation,
  type InvitationDetails,
  type Member,
  type MemberList,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationRecipient,
  type Readiness,
  type TenantContact,
  type TenantCustomer,
  type TenantDetail,
  type TenantHealth,
  type TenantItem,
  type TenantStatus,
  type UsageOverview,
} from "./types";

/**
 * Tolerant decoders for the payloads this feature reads. They never throw:
 * missing or malformed fields become honest defaults (null, 0, empty lists)
 * so a partial response renders as "unknown" instead of breaking the page.
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function asNullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

const TENANT_STATUSES: readonly TenantStatus[] = ["active", "suspended", "deleting"];
const TENANT_KINDS: readonly TenantKind[] = ["customer", "internal"];
const READINESS: readonly Readiness[] = ["green", "yellow", "red"];

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function nullableOneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

/** Tenant roles come as Restow roles; anything unknown is the least privileged role. */
function asTenantRole(value: unknown): TenantRole {
  return value === "tenant_admin" ? "tenant_admin" : "tenant_user";
}

export function decodeTenant(payload: unknown): TenantItem {
  const raw = asObject(payload);
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    slug: asString(raw.slug),
    // A server from before the own organisation existed sends no kind: all customers.
    kind: oneOf(TENANT_KINDS, raw.kind, "customer"),
    status: oneOf(TENANT_STATUSES, raw.status, "active"),
    customerNumber: asNullableString(raw.customerNumber),
    organizationId: asNullableString(raw.organizationId),
    mailboxCap: asNullableCount(raw.mailboxCap),
    createdAt: asNullableString(raw.createdAt),
    updatedAt: asNullableString(raw.updatedAt),
  };
}

/** `{ items: TenantDto[] }` (or a bare array); rows without an id are dropped. */
export function decodeTenantList(payload: unknown): TenantItem[] {
  return unwrapList<unknown>(payload)
    .map(decodeTenant)
    .filter((tenant) => tenant.id.length > 0);
}

const TENANT_LANGUAGES = ["de", "en"] as const;

function decodeCustomer(payload: unknown): TenantCustomer {
  const raw = asObject(payload);
  return {
    customerNumber: asNullableString(raw.customerNumber),
    vatId: asNullableString(raw.vatId),
    addressLine1: asNullableString(raw.addressLine1),
    addressLine2: asNullableString(raw.addressLine2),
    postalCode: asNullableString(raw.postalCode),
    city: asNullableString(raw.city),
    countryCode: asNullableString(raw.countryCode),
    language: nullableOneOf(TENANT_LANGUAGES, raw.language),
    timeZone: asNullableString(raw.timeZone),
  };
}

function decodeContact(payload: unknown): TenantContact {
  const raw = asObject(payload);
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    role: asNullableString(raw.role),
    email: asNullableString(raw.email),
    phone: asNullableString(raw.phone),
    isPrimary: raw.isPrimary === true,
  };
}

function decodeRecipient(payload: unknown): NotificationRecipient {
  const raw = asObject(payload);
  const categories = Array.isArray(raw.categories) ? raw.categories : [];
  return {
    id: asString(raw.id),
    email: asString(raw.email),
    name: asNullableString(raw.name),
    categories: categories.filter((category): category is NotificationCategory =>
      NOTIFICATION_CATEGORIES.includes(category as NotificationCategory),
    ),
  };
}

/** PATCH /tenants/:id/customer returns the customer data alone. */
export function decodeTenantCustomer(payload: unknown): TenantCustomer {
  return decodeCustomer(payload);
}

/** PUT /tenants/:id/contacts returns the replaced list as a bare array. */
export function decodeContactList(payload: unknown): TenantContact[] {
  return (Array.isArray(payload) ? payload : [])
    .map(decodeContact)
    .filter((contact) => contact.id.length > 0);
}

/** PUT /tenants/:id/notification-recipients returns the replaced list as a bare array. */
export function decodeRecipientList(payload: unknown): NotificationRecipient[] {
  return (Array.isArray(payload) ? payload : [])
    .map(decodeRecipient)
    .filter((recipient) => recipient.id.length > 0);
}

export function decodeTenantDetail(payload: unknown): TenantDetail {
  const raw = asObject(payload);
  const contacts = Array.isArray(raw.contacts) ? raw.contacts : [];
  const recipients = Array.isArray(raw.notificationRecipients) ? raw.notificationRecipients : [];
  return {
    ...decodeTenant(raw),
    memberCount: asCount(raw.memberCount),
    pendingInvitations: asCount(raw.pendingInvitations),
    keyVersion: asNullableCount(raw.keyVersion),
    customer: decodeCustomer(raw.customer),
    contacts: contacts.map(decodeContact).filter((contact) => contact.id.length > 0),
    notificationRecipients: recipients
      .map(decodeRecipient)
      .filter((recipient) => recipient.id.length > 0),
  };
}

function decodeMember(payload: unknown): Member {
  const raw = asObject(payload);
  return {
    userId: asString(raw.userId),
    name: asString(raw.name),
    email: asString(raw.email),
    role: asTenantRole(raw.role),
    joinedAt: asNullableString(raw.joinedAt),
  };
}

function decodeInvitation(payload: unknown): Invitation {
  const raw = asObject(payload);
  return {
    id: asString(raw.id),
    email: asString(raw.email),
    role: asTenantRole(raw.role),
    expiresAt: asNullableString(raw.expiresAt),
    createdAt: asNullableString(raw.createdAt),
  };
}

/** Members and pending invitations; only pending invitations are kept. */
export function decodeMemberList(payload: unknown): MemberList {
  const raw = asObject(payload);
  const members = Array.isArray(raw.members) ? raw.members : [];
  const invitations = Array.isArray(raw.invitations) ? raw.invitations : [];
  return {
    members: members.map(decodeMember).filter((member) => member.userId.length > 0),
    invitations: invitations
      .filter((invitation) => {
        const status = asObject(invitation).status;
        return status === undefined || status === "pending";
      })
      .map(decodeInvitation)
      .filter((invitation) => invitation.id.length > 0),
  };
}

export function decodeAddMemberResult(payload: unknown): AddMemberResult {
  const raw = asObject(payload);
  const role = asTenantRole(raw.role);
  const email = asString(raw.email);
  if (raw.status === "invited") {
    return {
      status: "invited",
      invitationId: asString(raw.invitationId),
      email,
      role,
      expiresAt: asNullableString(raw.expiresAt),
    };
  }
  return { status: "member", userId: asString(raw.userId), email, role };
}

/**
 * The readiness overview of one tenant (GET /verify/latest), condensed: the
 * worst rating, how many objects are not proven restorable and the newest
 * snapshot, which is the tenant's last successful backup.
 */
export function decodeTenantHealth(payload: unknown): TenantHealth {
  const raw = asObject(payload);
  const summary = asObject(raw.summary);
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  const lastBackupAt = objects.reduce<string | null>((latest, object) => {
    const snapshotAt = asNullableString(asObject(object).latestSnapshotAt);
    if (!snapshotAt || Number.isNaN(Date.parse(snapshotAt))) {
      return latest;
    }
    return latest === null || Date.parse(snapshotAt) > Date.parse(latest) ? snapshotAt : latest;
  }, null);
  return {
    readiness: nullableOneOf(READINESS, summary.overall),
    protectedObjects: asCount(summary.total),
    notReady: asCount(summary.red) + asCount(summary.unverified) + asCount(summary.noBackup),
    lastBackupAt,
    lastCheckedAt: asNullableString(summary.lastCheckedAt),
  };
}

/** GET /usage: the protected mailboxes of the installation and of each tenant. */
export function decodeUsageOverview(payload: unknown): UsageOverview {
  const raw = asObject(payload);
  const tenants = Array.isArray(raw.tenants) ? raw.tenants : [];
  const mailboxesByTenant: Record<string, number> = {};
  for (const entry of tenants) {
    const tenant = asObject(entry);
    const id = asString(tenant.id);
    if (id) {
      mailboxesByTenant[id] = asCount(tenant.mailboxes);
    }
  }
  return {
    usedMailboxes: asCount(raw.mailboxes),
    mailboxesByTenant,
  };
}

/** Timestamps from better-auth arrive as ISO strings (JSON) or Date objects. */
function asTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return asNullableString(value);
}

/**
 * better-auth `get-invitation`: the organization is the tenant (same name and
 * slug), the role is the organization role.
 */
export function decodeInvitationDetails(payload: unknown): InvitationDetails {
  const raw = asObject(payload);
  return {
    id: asString(raw.id),
    email: asString(raw.email),
    role: tenantRoleFromMemberRole(asNullableString(raw.role)),
    tenantName: asNullableString(raw.organizationName),
    tenantSlug: asNullableString(raw.organizationSlug),
    inviterEmail: asNullableString(raw.inviterEmail),
    expiresAt: asTimestamp(raw.expiresAt),
  };
}
