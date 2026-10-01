import { randomUUID } from "node:crypto";
import {
  type Database,
  type Tenant,
  type TenantContact,
  type TenantLanguage,
  type TenantNotificationRecipient,
  type TenantStatus,
  invitation,
  member,
  organization,
  providers,
  tenantContacts,
  tenantKeys,
  tenantNotificationRecipients,
  tenants,
  user,
} from "@restow/db";
import { and, asc, count, desc, eq, max, ne, sql } from "drizzle-orm";
import { auth } from "../../auth.js";
import { AUDIT_ACTIONS, audit } from "../../lib/audit.js";
import { authCall } from "../../lib/auth-errors.js";
import { featureEnabled, requireFeature } from "../../lib/features.js";
import { createTenantKey } from "../../lib/secrets.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import {
  type TenantRole,
  membershipRoleFromTenantRole,
  tenantRoleFromMembership,
} from "../../middleware/rbac.js";
import { ProblemError } from "../../problem.js";
import {
  belongsToOtherTenant,
  crossTenantTargetProblem,
  hasSignInMethod,
  invalidatePreviousLinks,
} from "../accounts/service.js";
import { insertWizardRules, rulesFromRecipients } from "../reports/defaults.js";
import type {
  AddMemberInput,
  CreateTenantInput,
  NotificationCategory,
  ReplaceNotificationRecipientsInput,
  ReplaceTenantContactsInput,
  UpdateTenantCustomerInput,
  UpdateTenantInput,
} from "./schemas.js";

const CUSTOMER_NUMBER_UNIQUE_INDEX = "tenants_customer_number_uq";

/** True when `error` (or its cause) is Postgres' unique violation on `constraint`. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function customerNumberTakenProblem(customerNumber: string): ProblemError {
  return new ProblemError(409, "Customer number already in use", {
    type: "urn:restow:problem:customer-number-taken",
    detail: `A tenant with customer number '${customerNumber}' already exists.`,
    extensions: { customerNumber },
  });
}

/**
 * Tenant lifecycle and membership.
 *
 * A tenant IS a better-auth organization (`tenants.organization_id`). Creating a
 * tenant creates the organization, the tenant row and its first data-encryption
 * key (wrapped by the env KEK) in one go; memberships are better-auth `member`
 * rows and map onto tenant roles (middleware/rbac.ts). Provider admins are NOT
 * members — their access comes from the global role and the `X-Restow-Tenant`
 * header — so the creator membership better-auth adds is removed again.
 *
 * Deleting a tenant never drops data synchronously: the tenant is marked
 * `deleting`, its organization (and with it every membership and invitation) is
 * removed so nobody can sign in to it, and the purge runs as an audited job.
 * The audit chain keeps referencing the tenant row (`on delete restrict`).
 */

/** Who performs an action, for the audit log. */
export interface Actor {
  id: string;
  email: string;
  ip: string | null;
  /**
   * Provider admins may add an existing account to more than one tenant;
   * tenant admins may not (`addMember`'s cross-tenant refusal, the same rule
   * the accounts feature's own `provisionAccount` applies).
   */
  isProviderAdmin: boolean;
}

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  organizationId: string | null;
  mailboxCap: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantDetailDto extends TenantDto {
  memberCount: number;
  pendingInvitations: number;
  keyVersion: number | null;
  customer: TenantCustomerDto;
  contacts: TenantContactDto[];
  notificationRecipients: NotificationRecipientDto[];
}

/** Customer data of the tenant wizard; every field is null until set. */
export interface TenantCustomerDto {
  customerNumber: string | null;
  vatId: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
  language: TenantLanguage | null;
  timeZone: string | null;
}

export interface TenantContactDto {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
}

export interface NotificationRecipientDto {
  id: string;
  email: string;
  name: string | null;
  categories: NotificationCategory[];
}

export interface MemberDto {
  userId: string;
  name: string;
  email: string;
  role: TenantRole;
  /** The raw organization role better-auth stores (`owner`, `admin`, `member`). */
  memberRole: string;
  joinedAt: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: TenantRole;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface MembersDto {
  members: MemberDto[];
  invitations: InvitationDto[];
}

export type AddMemberResult =
  | { status: "member"; userId: string; email: string; role: TenantRole }
  | { status: "invited"; invitationId: string; email: string; role: TenantRole; expiresAt: string };

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toDto(row: Tenant): TenantDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    organizationId: row.organizationId,
    mailboxCap: row.mailboxCap,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCustomerDto(row: Tenant): TenantCustomerDto {
  return {
    customerNumber: row.customerNumber,
    vatId: row.vatId,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    postalCode: row.postalCode,
    city: row.city,
    countryCode: row.countryCode,
    language: row.language,
    timeZone: row.timeZone,
  };
}

function toContactDto(row: TenantContact): TenantContactDto {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    email: row.email,
    phone: row.phone,
    isPrimary: row.isPrimary,
  };
}

/** The four notification flag columns as the category list the wizard edits. */
function categoriesFromRow(row: TenantNotificationRecipient): NotificationCategory[] {
  const categories: NotificationCategory[] = [];
  if (row.notifyJobFailures) categories.push("jobFailures");
  if (row.notifyWeeklyReport) categories.push("weeklyReport");
  if (row.notifyReadinessRed) categories.push("readinessRed");
  if (row.notifyLicenseUpdates) categories.push("licenseUpdates");
  return categories;
}

function flagsFromCategories(categories: readonly NotificationCategory[]) {
  const set = new Set(categories);
  return {
    notifyJobFailures: set.has("jobFailures"),
    notifyWeeklyReport: set.has("weeklyReport"),
    notifyReadinessRed: set.has("readinessRed"),
    notifyLicenseUpdates: set.has("licenseUpdates"),
  };
}

function toRecipientDto(row: TenantNotificationRecipient): NotificationRecipientDto {
  return { id: row.id, email: row.email, name: row.name, categories: categoriesFromRow(row) };
}

function notFound(): ProblemError {
  return new ProblemError(404, "Tenant not found");
}

/** All tenants of the installation (provider view): pass the installation pool. */
export async function listTenants(providerDb: Database): Promise<TenantDto[]> {
  const rows = await providerDb.select().from(tenants).orderBy(asc(tenants.name));
  return rows.map(toDto);
}

/** One tenant, or null. Read inside the tenant's own RLS context. */
export async function findTenant(db: Database, id: string): Promise<Tenant | null> {
  return withTenantTx(db, id, async (tx) => {
    const [row] = await tx.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return row ?? null;
  });
}

/** Tenant with membership, key, customer data, contacts and recipients; 404 when unknown. */
export async function getTenant(db: Database, id: string): Promise<TenantDetailDto> {
  const row = await findTenant(db, id);
  if (!row) {
    throw notFound();
  }
  const [members, pending, extra] = await Promise.all([
    row.organizationId ? countMembers(db, row.organizationId) : Promise.resolve(0),
    row.organizationId ? countPendingInvitations(db, row.organizationId) : Promise.resolve(0),
    withTenantTx(db, id, async (tx) => {
      const [latest] = await tx
        .select({ version: max(tenantKeys.keyVersion) })
        .from(tenantKeys)
        .where(eq(tenantKeys.tenantId, id));
      const contacts = await tx
        .select()
        .from(tenantContacts)
        .where(eq(tenantContacts.tenantId, id))
        .orderBy(desc(tenantContacts.isPrimary), asc(tenantContacts.createdAt));
      const recipients = await tx
        .select()
        .from(tenantNotificationRecipients)
        .where(eq(tenantNotificationRecipients.tenantId, id))
        .orderBy(asc(tenantNotificationRecipients.createdAt));
      return { keyVersion: latest?.version ?? null, contacts, recipients };
    }),
  ]);
  return {
    ...toDto(row),
    memberCount: members,
    pendingInvitations: pending,
    keyVersion: extra.keyVersion,
    customer: toCustomerDto(row),
    contacts: extra.contacts.map(toContactDto),
    notificationRecipients: extra.recipients.map(toRecipientDto),
  };
}

async function countMembers(db: Database, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(member)
    .where(eq(member.organizationId, organizationId));
  return row?.value ?? 0;
}

async function countPendingInvitations(db: Database, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(invitation)
    .where(and(eq(invitation.organizationId, organizationId), eq(invitation.status, "pending")));
  return row?.value ?? 0;
}

/** Whether the installation has a tenant yet; spans tenants, so on the installation pool. */
async function hasTenant(providerDb: Database): Promise<boolean> {
  const [row] = await providerDb.select({ id: tenants.id }).from(tenants).limit(1);
  return row !== undefined;
}

/** Whether a tenant or organization uses the slug; spans tenants, so on the installation pool. */
async function slugTaken(providerDb: Database, slug: string): Promise<boolean> {
  const [byTenant] = await providerDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (byTenant) {
    return true;
  }
  const [byOrganization] = await providerDb
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  return byOrganization !== undefined;
}

/**
 * Whether another tenant already carries this customer number (the unique
 * index is case-insensitive; `excludeTenantId` skips the tenant being
 * edited). Spans tenants, so on the installation pool.
 */
async function customerNumberTaken(
  providerDb: Database,
  customerNumber: string,
  excludeTenantId?: string,
): Promise<boolean> {
  const conditions = [sql`lower(${tenants.customerNumber}) = ${customerNumber.toLowerCase()}`];
  if (excludeTenantId) {
    conditions.push(ne(tenants.id, excludeTenantId));
  }
  const [row] = await providerDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(...conditions))
    .limit(1);
  return row !== undefined;
}

async function providerId(db: Database): Promise<string> {
  const [row] = await db.select({ id: providers.id }).from(providers).limit(1);
  if (!row) {
    throw new ProblemError(409, "Setup required", {
      type: "urn:restow:problem:setup-required",
      detail: "Complete the installation setup before creating tenants.",
    });
  }
  return row.id;
}

/**
 * Create a tenant: better-auth organization, tenant row (with its customer
 * data), first DEK, contact persons, notification recipients and audit entry,
 * all in one transaction. The organization is removed again if any of it
 * cannot be written, so a failure leaves nothing behind. The installation's
 * first tenant is always the core's; any further one exists only while an
 * extension enables `tenants.additional` (lib/features.ts). The checks that
 * span tenants (an existing tenant, slug, customer number) run on the
 * installation pool, the new tenant's rows inside its own pinned transaction
 * on `db`.
 */
export async function createTenant(
  db: Database,
  providerDb: Database,
  input: CreateTenantInput,
  actor: Actor,
): Promise<TenantDto> {
  if (await hasTenant(providerDb)) {
    await requireFeature(db, "tenants.additional");
  }
  const scheduledAllowed = await featureEnabled(db, "reports.timed");
  const provider = await providerId(db);
  if (await slugTaken(providerDb, input.slug)) {
    throw new ProblemError(409, "Slug already in use", {
      type: "urn:restow:problem:slug-taken",
      detail: `A tenant with slug '${input.slug}' already exists.`,
      extensions: { slug: input.slug },
    });
  }
  const customerNumber = input.customer?.customerNumber;
  if (customerNumber && (await customerNumberTaken(providerDb, customerNumber))) {
    throw customerNumberTakenProblem(customerNumber);
  }

  const org = await authCall(() =>
    auth.api.createOrganization({
      body: {
        name: input.name,
        slug: input.slug,
        userId: actor.id,
        keepCurrentActiveOrganization: true,
      },
    }),
  );
  // better-auth makes the creator an owner; provider admins are not members.
  await db
    .delete(member)
    .where(and(eq(member.organizationId, org.id), eq(member.userId, actor.id)));

  const id = randomUUID();
  try {
    const created = await withTenantTx(db, id, async (tx) => {
      let row: Tenant | undefined;
      try {
        [row] = await tx
          .insert(tenants)
          .values({
            id,
            providerId: provider,
            organizationId: org.id,
            name: input.name,
            slug: input.slug,
            ...input.customer,
          })
          .returning();
      } catch (error) {
        // A concurrent create can still race past the pre-check above; the
        // unique index is the final word, translated to the same 409.
        if (isUniqueViolation(error, CUSTOMER_NUMBER_UNIQUE_INDEX)) {
          throw customerNumberTakenProblem(customerNumber ?? "");
        }
        throw error;
      }
      if (!row) {
        throw new Error("tenant insert returned no row");
      }
      const key = await createTenantKey(tx, id);
      const insertedContacts =
        input.contacts && input.contacts.length > 0
          ? await tx
              .insert(tenantContacts)
              .values(input.contacts.map((contact) => ({ tenantId: id, ...contact })))
              .returning({ id: tenantContacts.id })
          : [];
      const insertedRecipients =
        input.notificationRecipients && input.notificationRecipients.length > 0
          ? await tx
              .insert(tenantNotificationRecipients)
              .values(
                input.notificationRecipients.map((recipient) => ({
                  tenantId: id,
                  email: recipient.email,
                  name: recipient.name ?? null,
                  ...flagsFromCategories(recipient.categories),
                })),
              )
              .returning({ id: tenantNotificationRecipients.id })
          : [];
      // Each chosen category becomes a rule under Alerts & reports
      // (features/reports/defaults.ts); the weekly report only while
      // time-triggered reports are on (`reports.timed`).
      const reportRuleCount = await insertWizardRules(
        tx,
        rulesFromRecipients({
          tenantId: id,
          recipients: input.notificationRecipients ?? [],
          language: input.customer?.language ?? null,
          timeZone: input.customer?.timeZone ?? null,
          createdBy: actor.id,
          scheduledAllowed,
          now: new Date(),
        }),
      );
      await audit(tx, {
        tenantId: id,
        actor: actor.email,
        actorUserId: actor.id,
        action: AUDIT_ACTIONS.tenantCreated,
        target: id,
        targetType: "tenant",
        ip: actor.ip,
        details: {
          name: input.name,
          slug: input.slug,
          organizationId: org.id,
          keyVersion: key.keyVersion,
          customerNumber: customerNumber ?? null,
          // Ids, never contact or recipient personal data (name, e-mail, phone).
          contactCount: insertedContacts.length,
          contactIds: insertedContacts.map((contact) => contact.id),
          notificationRecipientCount: insertedRecipients.length,
          recipientIds: insertedRecipients.map((recipient) => recipient.id),
          reportRuleCount,
        },
      });
      return row;
    });
    return toDto(created);
  } catch (error) {
    await db.delete(organization).where(eq(organization.id, org.id));
    throw error;
  }
}

/**
 * Replace a tenant's customer data (address, VAT id, customer number,
 * locale). `null` clears a field; an omitted key leaves it as it is.
 */
export async function updateTenantCustomer(
  db: Database,
  providerDb: Database,
  id: string,
  patch: UpdateTenantCustomerInput,
  actor: Actor,
): Promise<TenantCustomerDto> {
  if (patch.customerNumber && (await customerNumberTaken(providerDb, patch.customerNumber, id))) {
    throw customerNumberTakenProblem(patch.customerNumber);
  }
  const updated = await withTenantTx(db, id, async (tx) => {
    const [current] = await tx.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!current) {
      throw notFound();
    }
    if (current.status === "deleting") {
      throw new ProblemError(409, "Tenant is being deleted");
    }
    let row: Tenant | undefined;
    try {
      [row] = await tx.update(tenants).set(patch).where(eq(tenants.id, id)).returning();
    } catch (error) {
      if (isUniqueViolation(error, CUSTOMER_NUMBER_UNIQUE_INDEX)) {
        throw customerNumberTakenProblem(patch.customerNumber ?? "");
      }
      throw error;
    }
    if (!row) {
      throw notFound();
    }
    await audit(tx, {
      tenantId: id,
      actor: actor.email,
      actorUserId: actor.id,
      action: "tenant.customer.updated",
      target: id,
      targetType: "tenant",
      ip: actor.ip,
      details: { fields: Object.keys(patch) },
    });
    return row;
  });
  return toCustomerDto(updated);
}

/**
 * Replace a tenant's contact persons as one set: simpler and safer than
 * per-row edits for enforcing "at most one primary" (schemas.ts) at every
 * save. The audit entry names how many contacts and whether one is primary,
 * never their names or contact details.
 */
export async function replaceTenantContacts(
  db: Database,
  id: string,
  contacts: ReplaceTenantContactsInput,
  actor: Actor,
): Promise<TenantContactDto[]> {
  const rows = await withTenantTx(db, id, async (tx) => {
    const [current] = await tx
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, id));
    if (!current) {
      throw notFound();
    }
    if (current.status === "deleting") {
      throw new ProblemError(409, "Tenant is being deleted");
    }
    await tx.delete(tenantContacts).where(eq(tenantContacts.tenantId, id));
    const inserted =
      contacts.length > 0
        ? await tx
            .insert(tenantContacts)
            .values(contacts.map((contact) => ({ tenantId: id, ...contact })))
            .returning()
        : [];
    await audit(tx, {
      tenantId: id,
      actor: actor.email,
      actorUserId: actor.id,
      action: "tenant.contacts.updated",
      target: id,
      targetType: "tenant",
      ip: actor.ip,
      details: {
        count: contacts.length,
        hasPrimary: contacts.some((contact) => contact.isPrimary),
        // Ids, never names or contact details (personal data stays out of the audit log).
        contactIds: inserted.map((contact) => contact.id),
      },
    });
    return inserted;
  });
  return rows.map(toContactDto);
}

/**
 * Replace a tenant's notification recipients as one set (same rationale as
 * {@link replaceTenantContacts}). The audit entry counts recipients per
 * category, never the addresses.
 */
export async function replaceTenantNotificationRecipients(
  db: Database,
  id: string,
  recipients: ReplaceNotificationRecipientsInput,
  actor: Actor,
): Promise<NotificationRecipientDto[]> {
  const rows = await withTenantTx(db, id, async (tx) => {
    const [current] = await tx
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, id));
    if (!current) {
      throw notFound();
    }
    if (current.status === "deleting") {
      throw new ProblemError(409, "Tenant is being deleted");
    }
    await tx
      .delete(tenantNotificationRecipients)
      .where(eq(tenantNotificationRecipients.tenantId, id));
    const inserted =
      recipients.length > 0
        ? await tx
            .insert(tenantNotificationRecipients)
            .values(
              recipients.map((recipient) => ({
                tenantId: id,
                email: recipient.email,
                name: recipient.name ?? null,
                ...flagsFromCategories(recipient.categories),
              })),
            )
            .returning()
        : [];
    const perCategory: Record<NotificationCategory, number> = {
      jobFailures: 0,
      weeklyReport: 0,
      readinessRed: 0,
      licenseUpdates: 0,
    };
    for (const recipient of recipients) {
      for (const category of recipient.categories) {
        perCategory[category] += 1;
      }
    }
    await audit(tx, {
      tenantId: id,
      actor: actor.email,
      actorUserId: actor.id,
      action: "tenant.notification_recipients.updated",
      target: id,
      targetType: "tenant",
      ip: actor.ip,
      // Ids and per-category counts, never the recipient addresses.
      details: { count: recipients.length, perCategory, recipientIds: inserted.map((r) => r.id) },
    });
    return inserted;
  });
  return rows.map(toRecipientDto);
}

/** Update name, status or mailbox cap; the organization name follows the tenant name. */
export async function updateTenant(
  db: Database,
  id: string,
  patch: UpdateTenantInput,
  actor: Actor,
): Promise<TenantDto> {
  const updated = await withTenantTx(db, id, async (tx) => {
    const [current] = await tx.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!current) {
      throw notFound();
    }
    if (current.status === "deleting") {
      throw new ProblemError(409, "Tenant is being deleted");
    }
    const [row] = await tx
      .update(tenants)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.mailboxCap !== undefined ? { mailboxCap: patch.mailboxCap } : {}),
      })
      .where(eq(tenants.id, id))
      .returning();
    if (!row) {
      throw notFound();
    }
    await audit(tx, {
      tenantId: id,
      actor: actor.email,
      actorUserId: actor.id,
      action: AUDIT_ACTIONS.tenantUpdated,
      target: id,
      targetType: "tenant",
      ip: actor.ip,
      details: { ...patch },
    });
    return row;
  });
  if (patch.name !== undefined && updated.organizationId) {
    await db
      .update(organization)
      .set({ name: patch.name })
      .where(eq(organization.id, updated.organizationId));
  }
  return toDto(updated);
}

/**
 * Mark a tenant for deletion and revoke every login to it. Data removal is the
 * purge job's work; the row stays so the audit chain remains intact.
 */
export async function deleteTenant(db: Database, id: string, actor: Actor): Promise<TenantDto> {
  const marked = await withTenantTx(db, id, async (tx) => {
    const [row] = await tx
      .update(tenants)
      .set({ status: "deleting" })
      .where(eq(tenants.id, id))
      .returning();
    if (!row) {
      throw notFound();
    }
    await audit(tx, {
      tenantId: id,
      actor: actor.email,
      actorUserId: actor.id,
      action: AUDIT_ACTIONS.tenantDeleted,
      target: id,
      targetType: "tenant",
      ip: actor.ip,
      details: { organizationId: row.organizationId, slug: row.slug },
    });
    return row;
  });
  if (marked.organizationId) {
    // Cascades to member and invitation; tenants.organization_id becomes null.
    await db.delete(organization).where(eq(organization.id, marked.organizationId));
  }
  return { ...toDto(marked), organizationId: null };
}

/** Members and pending invitations of a tenant's organization. */
export async function listMembers(db: Database, tenant: Tenant): Promise<MembersDto> {
  if (!tenant.organizationId) {
    return { members: [], invitations: [] };
  }
  const [members, invitations] = await Promise.all([
    db
      .select({
        userId: member.userId,
        name: user.name,
        email: user.email,
        memberRole: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, tenant.organizationId))
      .orderBy(asc(user.email)),
    db
      .select()
      .from(invitation)
      .where(
        and(eq(invitation.organizationId, tenant.organizationId), eq(invitation.status, "pending")),
      )
      .orderBy(desc(invitation.createdAt)),
  ]);
  return {
    members: members.map((row) => ({
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: tenantRoleFromMembership(row.memberRole),
      memberRole: row.memberRole,
      joinedAt: row.joinedAt.toISOString(),
    })),
    invitations: invitations.map((row) => ({
      id: row.id,
      email: row.email,
      role: tenantRoleFromMembership(row.role),
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

function requireOrganization(tenant: Tenant): string {
  if (!tenant.organizationId || tenant.status === "deleting") {
    throw new ProblemError(409, "Tenant is being deleted");
  }
  return tenant.organizationId;
}

/**
 * Add a person to a tenant: an existing account becomes a member right away,
 * an unknown email receives a pending invitation it can accept after signing
 * in (better-auth `acceptInvitation`).
 *
 * An existing account that already belongs to a different tenant is refused
 * for a tenant admin, the same cross-tenant rule the accounts feature's own
 * `provisionAccount` applies — only a provider admin may place the same
 * person in more than one tenant. When the account added has no working
 * sign-in yet (no credential, passkey or linked Microsoft account), any
 * set-password link issued for it before this membership existed is
 * invalidated: otherwise whoever still holds that link's raw token could
 * redeem it later and inherit the membership just added here too (see
 * accounts/service.ts, `issuedByProviderAdmin`, for the matching check at
 * redeem time).
 */
export async function addMember(
  db: Database,
  tenant: Tenant,
  input: AddMemberInput,
  actor: Actor,
): Promise<AddMemberResult> {
  const organizationId = requireOrganization(tenant);
  const email = input.email.toLowerCase();
  const memberRole = membershipRoleFromTenantRole(input.role);

  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (existing) {
    if (!actor.isProviderAdmin && (await belongsToOtherTenant(db, existing.id, organizationId))) {
      throw crossTenantTargetProblem();
    }
    const wasPending = !(await hasSignInMethod(db, existing.id));
    await authCall(() =>
      auth.api.addMember({ body: { userId: existing.id, organizationId, role: memberRole } }),
    );
    if (wasPending) {
      await invalidatePreviousLinks(db, existing.id);
    }
    await audit(db, {
      tenantId: tenant.id,
      actor: actor.email,
      actorUserId: actor.id,
      action: AUDIT_ACTIONS.tenantMemberAdded,
      target: existing.id,
      targetType: "user",
      onBehalfOf: email,
      ip: actor.ip,
      details: { role: input.role },
    });
    return { status: "member", userId: existing.id, email, role: input.role };
  }

  const [pending] = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.email, email),
        eq(invitation.status, "pending"),
      ),
    )
    .limit(1);
  if (pending) {
    throw new ProblemError(409, "Already invited", {
      detail: `${email} already has a pending invitation.`,
      extensions: { invitationId: pending.id },
    });
  }

  const id = randomUUID();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  await db.insert(invitation).values({
    id,
    organizationId,
    email,
    role: memberRole,
    status: "pending",
    expiresAt,
    inviterId: actor.id,
  });
  await audit(db, {
    tenantId: tenant.id,
    actor: actor.email,
    actorUserId: actor.id,
    action: AUDIT_ACTIONS.tenantMemberInvited,
    target: id,
    targetType: "invitation",
    onBehalfOf: email,
    ip: actor.ip,
    details: { role: input.role, expiresAt: expiresAt.toISOString() },
  });
  return {
    status: "invited",
    invitationId: id,
    email,
    role: input.role,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Change a member's tenant role. */
export async function updateMemberRole(
  db: Database,
  tenant: Tenant,
  userId: string,
  role: TenantRole,
  actor: Actor,
): Promise<MemberDto> {
  const organizationId = requireOrganization(tenant);
  const [row] = await db
    .update(member)
    .set({ role: membershipRoleFromTenantRole(role) })
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .returning();
  if (!row) {
    throw new ProblemError(404, "Member not found");
  }
  const [account] = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  await audit(db, {
    tenantId: tenant.id,
    actor: actor.email,
    actorUserId: actor.id,
    action: "tenant.member.role_changed",
    target: userId,
    targetType: "user",
    onBehalfOf: account?.email ?? null,
    ip: actor.ip,
    details: { role },
  });
  return {
    userId,
    name: account?.name ?? "",
    email: account?.email ?? "",
    role,
    memberRole: row.role,
    joinedAt: row.createdAt.toISOString(),
  };
}

/** Remove a member from a tenant (their account stays). */
export async function removeMember(
  db: Database,
  tenant: Tenant,
  userId: string,
  actor: Actor,
): Promise<void> {
  const organizationId = requireOrganization(tenant);
  const removed = await db
    .delete(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .returning({ id: member.id });
  if (removed.length === 0) {
    throw new ProblemError(404, "Member not found");
  }
  await audit(db, {
    tenantId: tenant.id,
    actor: actor.email,
    actorUserId: actor.id,
    action: "tenant.member.removed",
    target: userId,
    targetType: "user",
    ip: actor.ip,
  });
}

/** Cancel a pending invitation. */
export async function cancelInvitation(
  db: Database,
  tenant: Tenant,
  invitationId: string,
  actor: Actor,
): Promise<void> {
  const organizationId = requireOrganization(tenant);
  const updated = await db
    .update(invitation)
    .set({ status: "canceled" })
    .where(
      and(
        eq(invitation.id, invitationId),
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
      ),
    )
    .returning({ id: invitation.id, email: invitation.email });
  const row = updated[0];
  if (!row) {
    throw new ProblemError(404, "Invitation not found");
  }
  await audit(db, {
    tenantId: tenant.id,
    actor: actor.email,
    actorUserId: actor.id,
    action: "tenant.member.invitation_canceled",
    target: invitationId,
    targetType: "invitation",
    onBehalfOf: row.email,
    ip: actor.ip,
  });
}
