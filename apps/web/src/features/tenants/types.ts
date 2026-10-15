import type { TenantKind, TenantRole } from "@/lib/api";

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
  /** `internal` for the operator's own organisation (at most one, listed first), else `customer`. */
  kind: TenantKind;
  status: TenantStatus;
  /** The provider's customer number; null until set. */
  customerNumber: string | null;
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

/** A recipient's entry for the weekly report (the report is no event). */
export const WEEKLY_REPORT_ENTRY = "report.weekly";

/**
 * The events a category stands for (mirrors CATEGORY_EVENTS in apps/api
 * features/reports/defaults.ts). A category is a shortcut: ticking it adds its events to the
 * recipient's column of the notification matrix, unticking takes them away.
 */
export const CATEGORY_EVENTS: Readonly<Record<NotificationCategory, readonly string[]>> = {
  jobFailures: ["backup.failed", "restore.failed", "archive.failed", "directory.failed"],
  readinessRed: ["verify.red", "scrub.corrupt"],
  weeklyReport: [WEEKLY_REPORT_ENTRY],
  licenseUpdates: [],
};

/** Whether the column holds every event of `category`. */
export function categoryChosen(events: readonly string[], category: NotificationCategory): boolean {
  const covered = CATEGORY_EVENTS[category];
  return covered.length > 0 && covered.every((event) => events.includes(event));
}

/** The column with the events of `category` added or taken away; the rest stays. */
export function withCategory(
  events: readonly string[],
  category: NotificationCategory,
  on: boolean,
): string[] {
  const covered = CATEGORY_EVENTS[category];
  const rest = events.filter((event) => !covered.includes(event));
  return on ? [...rest, ...covered] : rest;
}

/** The events of the categories. */
export function eventsOfCategories(categories: readonly NotificationCategory[]): string[] {
  return [...new Set(categories.flatMap((category) => CATEGORY_EVENTS[category]))];
}

/** How many of the column's events no offered category covers (chosen in the matrix). */
export function eventsBeyondCategories(events: readonly string[]): number {
  const covered = new Set(
    OFFERED_NOTIFICATION_CATEGORIES.flatMap((category) => CATEGORY_EVENTS[category]),
  );
  return events.filter((event) => !covered.has(event)).length;
}

export interface NotificationRecipient {
  id: string;
  email: string;
  name: string | null;
  /** The recipient's column of the notification matrix: catalog events and `report.weekly`. */
  events: string[];
  /** The categories whose events `events` holds completely. */
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
  /** The recipient's column of the notification matrix (the categories are shortcuts for it). */
  events: string[];
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

/** The operator's own organisation, created from its name; the server derives the slug. */
export interface CreateOwnOrganisationInput {
  name: string;
}

export interface UpdateTenantInput {
  name?: string;
  status?: Exclude<TenantStatus, "deleting">;
  mailboxCap?: number | null;
}

export interface AddMemberInput {
  email: string;
  role: TenantRole;
}
