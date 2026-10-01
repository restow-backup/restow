import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { organization } from "./auth.js";
import { providers } from "./providers.js";

/**
 * Tenant lifecycle. `suspended` keeps data but stops jobs and logins;
 * `deleting` marks a tenant whose data is being purged (audited).
 */
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "suspended", "deleting"]);

/** A tenant's preferred UI/notification language; null defers to the installation default. */
export const tenantLanguageEnum = pgEnum("tenant_language", ["de", "en"]);

/**
 * A tenant is a customer organisation. Every tenant-scoped table
 * carries `tenant_id` and is isolated by Row Level Security (see sql/rls.sql).
 * Provider admins switch tenants explicitly; queries are never cross-tenant.
 *
 * A tenant IS a better-auth organization: memberships and tenant roles live in
 * better-auth (`member.role` owner/admin = tenant_admin, member = tenant_user)
 * and `organization_id` links the two. The link is `set null` on organization
 * delete because tenant data is only ever removed by the audited purge path.
 */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    // URL/route-safe short name for tenant switching in the UI and API.
    slug: text("slug").notNull(),
    status: tenantStatusEnum("status").notNull().default("active"),
    // Mailbox cap the provider agreed with this customer (null = none). A reference
    // value for the provider's dashboards; Restow never blocks protecting mailboxes.
    // The column keeps its historical name so no migration is needed.
    mailboxCap: integer("edition_limit_mailboxes"),
    // When the recommended schedules were applied to this tenant (once). Null
    // until then; set, the scheduler never re-creates a schedule an admin deleted.
    scheduleDefaultsAppliedAt: timestamp("schedule_defaults_applied_at", { withTimezone: true }),
    // --- Customer data (SPE tenant wizard: internal customer number, billing
    // address, locale). All nullable: a tenant created without the wizard (or
    // before it existed) simply has none of this set. ---
    // Provider-assigned customer number; unique per installation (case-insensitive)
    // when set, so two tenants never collide on the same number.
    customerNumber: text("customer_number"),
    // VAT identification number (e.g. "DE123456789"), as given by the customer; not validated.
    vatId: text("vat_id"),
    addressLine1: text("address_line1"),
    // Suite, floor, c/o — optional second address line.
    addressLine2: text("address_line2"),
    postalCode: text("postal_code"),
    city: text("city"),
    // ISO 3166-1 alpha-2 (e.g. "DE", "AT").
    countryCode: text("country_code"),
    // Null defers to the installation default language.
    language: tenantLanguageEnum("language"),
    // IANA time zone name (e.g. "Europe/Berlin"); null defers to the installation default.
    timeZone: text("time_zone"),
    // The tenant's journal SMTP recipient token (docs/IMAP.md, journal receiver
    // section): Exchange Online journaling is configured to send reports to `journal+<journalToken>@<journal host>`. Opaque,
    // random, url-safe; null until the tenant's journal setup page issues
    // one. Never the tenant id itself, so a leaked address cannot be turned
    // back into a tenant lookup key by guessing.
    journalToken: text("journal_token"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("tenants_slug_uq").on(t.slug),
    uniqueIndex("tenants_organization_uq").on(t.organizationId),
    uniqueIndex("tenants_customer_number_uq")
      .on(sql`lower(${t.customerNumber})`)
      .where(sql`${t.customerNumber} IS NOT NULL`),
    uniqueIndex("tenants_journal_token_uq")
      .on(t.journalToken)
      .where(sql`${t.journalToken} IS NOT NULL`),
  ],
);

/**
 * Per-tenant encryption keys. Chunks are encrypted with a tenant Data
 * Encryption Key (DEK); the DEK itself is stored only wrapped by the
 * environment/KMS Key Encryption Key (KEK). `keyVersion` supports rotation:
 * new chunks use the newest active DEK, older chunks stay readable via their
 * recorded version. Only the wrapped DEK is ever persisted here — never plaintext.
 */
export const tenantKeys = pgTable(
  "tenant_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    keyVersion: integer("key_version").notNull(),
    // Base64 of the DEK, encrypted (AES-256-GCM) with the KEK from env/KMS.
    encryptedDek: text("encrypted_dek").notNull(),
    // Identifier of the KEK used to wrap this DEK (supports KEK rotation).
    kekId: text("kek_id"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("tenant_keys_tenant_version_uq").on(t.tenantId, t.keyVersion)],
);

/**
 * A contact person for a tenant (SPE tenant wizard), e.g. the customer's IT
 * lead or billing contact. `role` is a free-text label ("IT contact",
 * "Billing"), not an access-control role. At most one contact per tenant may
 * be marked primary.
 */
export const tenantContacts = pgTable(
  "tenant_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Free-text label describing this contact's function, not an app role.
    role: text("role"),
    email: text("email"),
    phone: text("phone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("tenant_contacts_tenant_primary_uq")
      .on(t.tenantId)
      .where(sql`${t.isPrimary} = true`),
  ],
);

/**
 * Who receives operational notification e-mails for a tenant (job failures,
 * the weekly report, a readiness turning red, license/update reminders),
 * independent of who has a login. Each flag opts that recipient into one kind
 * of notification; a recipient with every flag false is kept but silent.
 */
export const tenantNotificationRecipients = pgTable(
  "tenant_notification_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    notifyJobFailures: boolean("notify_job_failures").notNull().default(false),
    notifyWeeklyReport: boolean("notify_weekly_report").notNull().default(false),
    notifyReadinessRed: boolean("notify_readiness_red").notNull().default(false),
    notifyLicenseUpdates: boolean("notify_license_updates").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("tenant_notification_recipients_tenant_email_uq").on(
      t.tenantId,
      sql`lower(${t.email})`,
    ),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantKey = typeof tenantKeys.$inferSelect;
export type NewTenantKey = typeof tenantKeys.$inferInsert;
export type TenantContact = typeof tenantContacts.$inferSelect;
export type NewTenantContact = typeof tenantContacts.$inferInsert;
export type TenantNotificationRecipient = typeof tenantNotificationRecipients.$inferSelect;
export type NewTenantNotificationRecipient = typeof tenantNotificationRecipients.$inferInsert;
export type TenantStatus = (typeof tenantStatusEnum.enumValues)[number];
export type TenantLanguage = (typeof tenantLanguageEnum.enumValues)[number];
