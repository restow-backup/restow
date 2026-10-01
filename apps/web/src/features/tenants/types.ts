import type { TenantRole } from "@/lib/api";

/**
 * Shapes of the tenants feature, mirroring the DTOs of
 * apps/api/src/features/tenants (tenants, members, invitations), the mailbox
 * usage (`GET /api/v1/usage`) and the readiness overview
 * (apps/api/src/features/verify). The decoders in `decoders.ts` turn raw
 * payloads into these types.
 */

/** `deleting` is set by DELETE only; the purge job removes the data afterwards. */
export type TenantStatus = "active" | "suspended" | "deleting";

export interface TenantItem {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  organizationId: string | null;
  /** Mailbox cap the provider agreed with the customer; null = none. Never enforced. */
  mailboxCap: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TenantDetail extends TenantItem {
  memberCount: number;
  pendingInvitations: number;
  /** Version of the newest data-encryption key; null before the first key exists. */
  keyVersion: number | null;
  customer: TenantCustomer;
  contacts: TenantContact[];
  notificationRecipients: NotificationRecipient[];
}

/** Customer data of the tenant wizard; every field is null until set. */
export interface TenantCustomer {
  customerNumber: string | null;
  vatId: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
  language: "de" | "en" | null;
  timeZone: string | null;
}

export interface TenantContact {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
}

/**
 * A category of the wizard's notification step. Each one the wizard offers
 * becomes a rule under Alerts when the tenant is created;
 * "licenseUpdates" is still decoded from older data but no longer offered,
 * because nothing raises such an event yet.
 */
export type NotificationCategory =
  | "jobFailures"
  | "weeklyReport"
  | "readinessRed"
  | "licenseUpdates";

/** Every category, in the order the wizard's checkboxes and the review show them. */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "jobFailures",
  "weeklyReport",
  "readinessRed",
  "licenseUpdates",
];

/** The categories the wizard offers: each becomes a rule when the tenant is created. */
export const OFFERED_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "jobFailures",
  "readinessRed",
  "weeklyReport",
];

export interface NotificationRecipient {
  id: string;
  email: string;
  name: string | null;
  categories: NotificationCategory[];
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: TenantRole;
  joinedAt: string | null;
}

export interface Invitation {
  id: string;
  email: string;
  role: TenantRole;
  expiresAt: string | null;
  createdAt: string | null;
}

export interface MemberList {
  members: Member[];
  invitations: Invitation[];
}

/** POST /tenants/:id/members: an existing account joins at once, anyone else is invited. */
export type AddMemberResult =
  | { status: "member"; userId: string; email: string; role: TenantRole }
  | {
      status: "invited";
      invitationId: string;
      email: string;
      role: TenantRole;
      expiresAt: string | null;
    };

/** An invitation as its recipient sees it (better-auth `get-invitation`). */
export interface InvitationDetails {
  id: string;
  email: string;
  role: TenantRole;
  tenantName: string | null;
  tenantSlug: string | null;
  inviterEmail: string | null;
  expiresAt: string | null;
}

export type Readiness = "green" | "yellow" | "red";

/**
 * What the tenant list shows per tenant, condensed from its readiness
 * overview. `readiness` is null while the tenant protects nothing yet.
 */
export interface TenantHealth {
  readiness: Readiness | null;
  protectedObjects: number;
  /** Objects that are not proven restorable: red, unverified or without backup. */
  notReady: number;
  /** Newest snapshot across all protected objects. */
  lastBackupAt: string | null;
  lastCheckedAt: string | null;
}

/** Protected mailboxes of the installation and per tenant (`GET /api/v1/usage`). */
export interface UsageOverview {
  /** Protected mailboxes of the whole installation. */
  usedMailboxes: number;
  /** Protected mailboxes per tenant id. */
  mailboxesByTenant: Record<string, number>;
}

/** Every field independently optional: a tenant may carry only some of it. */
export interface CustomerDataInput {
  customerNumber?: string;
  vatId?: string;
  addressLine1?: string;
  addressLine2?: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
  language?: "de" | "en";
  timeZone?: string;
}

export interface TenantContactInput {
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  isPrimary: boolean;
}

export interface NotificationRecipientInput {
  email: string;
  name?: string;
  categories: NotificationCategory[];
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  /** Tenant wizard extras; omitted entirely by the plain create form. */
  customer?: CustomerDataInput;
  contacts?: TenantContactInput[];
  notificationRecipients?: NotificationRecipientInput[];
}

/** `null` clears a field, an omitted key leaves it as it is. */
export type UpdateTenantCustomerInput = {
  [K in keyof CustomerDataInput]?: CustomerDataInput[K] | null;
};

export interface UpdateTenantInput {
  name?: string;
  status?: Exclude<TenantStatus, "deleting">;
  mailboxCap?: number | null;
}

export interface AddMemberInput {
  email: string;
  role: TenantRole;
}
