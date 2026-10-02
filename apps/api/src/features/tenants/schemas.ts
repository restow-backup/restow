import { z } from "zod";

/** Request schemas for the tenants feature (same style as apps/api/src/schemas.ts). */

/** URL/route-safe short name: lowercase letters, digits and single hyphens. */
export const tenantSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and hyphens.");

/** A tenant's display name; the same rule for customers and for the operator's own organisation. */
export const tenantNameSchema = z.string().trim().min(1).max(200);

export const tenantRoleSchema = z.enum(["tenant_admin", "tenant_user"]);
export const tenantStatusSchema = z.enum(["active", "suspended"]);
export const tenantLanguageSchema = z.enum(["de", "en"]);

// --- Customer data (tenant wizard) -----------------------------------------

/** ISO 3166-1 alpha-2, stored upper-case. */
export const countryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "Use a two-letter country code.")
  .transform((value) => value.toUpperCase());

export const customerNumberSchema = z.string().trim().min(1).max(64);

/** Whether the ICU engine recognizes `value` as a time zone (mirrors the web's check). */
export function isValidTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "Use a valid IANA time zone name, e.g. Europe/Berlin.");

/** Every field is independently optional: a tenant may carry only some of them. */
export const customerDataSchema = z.object({
  customerNumber: customerNumberSchema.optional(),
  vatId: z.string().trim().min(1).max(32).optional(),
  addressLine1: z.string().trim().min(1).max(200).optional(),
  addressLine2: z.string().trim().min(1).max(200).optional(),
  postalCode: z.string().trim().min(1).max(20).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  countryCode: countryCodeSchema.optional(),
  language: tenantLanguageSchema.optional(),
  timeZone: timeZoneSchema.optional(),
});
export type CustomerDataInput = z.infer<typeof customerDataSchema>;

/** `null` clears a field, an omitted key leaves it as it is. */
export const updateTenantCustomerSchema = z
  .object({
    customerNumber: customerNumberSchema.nullable().optional(),
    vatId: z.string().trim().min(1).max(32).nullable().optional(),
    addressLine1: z.string().trim().min(1).max(200).nullable().optional(),
    addressLine2: z.string().trim().min(1).max(200).nullable().optional(),
    postalCode: z.string().trim().min(1).max(20).nullable().optional(),
    city: z.string().trim().min(1).max(120).nullable().optional(),
    countryCode: countryCodeSchema.nullable().optional(),
    language: tenantLanguageSchema.nullable().optional(),
    timeZone: timeZoneSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "Nothing to update." });
export type UpdateTenantCustomerInput = z.infer<typeof updateTenantCustomerSchema>;

// --- Contacts -------------------------------------------------------------------

export const tenantContactInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Free-text function label ("IT contact", "Billing"), not an app role. */
  role: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().min(1).max(320).email().optional(),
  phone: z.string().trim().min(1).max(64).optional(),
  isPrimary: z.boolean().default(false),
});
export type TenantContactInput = z.infer<typeof tenantContactInputSchema>;

/** Replaces the whole contact list; exactly one contact must be primary whenever the list is non-empty. */
export const replaceTenantContactsSchema = z
  .array(tenantContactInputSchema)
  .max(20)
  .refine(
    (contacts) => {
      const primaries = contacts.filter((contact) => contact.isPrimary).length;
      return contacts.length === 0 ? primaries === 0 : primaries === 1;
    },
    { message: "onePrimaryContact" },
  );
export type ReplaceTenantContactsInput = z.infer<typeof replaceTenantContactsSchema>;

// --- Notification recipients -----------------------------------------------------

export const notificationCategorySchema = z.enum([
  "jobFailures",
  "weeklyReport",
  "readinessRed",
  "licenseUpdates",
]);
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

export const notificationRecipientInputSchema = z.object({
  email: z.string().trim().min(1).max(320).email(),
  name: z.string().trim().min(1).max(200).optional(),
  categories: z.array(notificationCategorySchema).max(4).default([]),
});
export type NotificationRecipientInput = z.infer<typeof notificationRecipientInputSchema>;

/** Replaces the whole recipient list; the same address cannot recur. */
export const replaceNotificationRecipientsSchema = z
  .array(notificationRecipientInputSchema)
  .max(50)
  .refine(
    (recipients) => {
      const seen = new Set(recipients.map((recipient) => recipient.email.toLowerCase()));
      return seen.size === recipients.length;
    },
    { message: "duplicateRecipient" },
  );
export type ReplaceNotificationRecipientsInput = z.infer<
  typeof replaceNotificationRecipientsSchema
>;

// --- Create / update tenant -------------------------------------------------------

export const createTenantSchema = z.object({
  name: tenantNameSchema,
  slug: tenantSlugSchema,
  /** Tenant wizard extras: all optional, so the minimal `{ name, slug }` request
   *  keeps working unchanged. */
  customer: customerDataSchema.optional(),
  contacts: replaceTenantContactsSchema.optional(),
  notificationRecipients: replaceNotificationRecipientsSchema.optional(),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

/**
 * The operator's own organisation, created from its name alone: the slug is
 * derived from the name (./slug.ts) unless the caller names one.
 */
export const createInternalTenantSchema = z.object({
  name: tenantNameSchema,
  slug: tenantSlugSchema.optional(),
});
export type CreateInternalTenantInput = z.infer<typeof createInternalTenantSchema>;

/** Marking an existing tenant as the operator's own organisation. */
export const markInternalTenantSchema = z.object({
  /**
   * Another tenant is the own organisation already: move the mark to this one
   * (the other becomes a customer). Without it that is refused with 409, so a
   * stray request cannot move the mark.
   */
  confirmSwitch: z.boolean().default(false),
});
export type MarkInternalTenantInput = z.infer<typeof markInternalTenantSchema>;

export const updateTenantSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    /** `deleting` is set only through DELETE; suspending stops jobs and logins. */
    status: tenantStatusSchema.optional(),
    /** Mailbox cap agreed with the customer (a reference value, never enforced); null removes it. */
    mailboxCap: z.number().int().min(0).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "Nothing to update." });
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

export const addMemberSchema = z.object({
  email: z.string().trim().email(),
  role: tenantRoleSchema,
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({
  role: tenantRoleSchema,
});
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const tenantIdParamSchema = z.object({ id: z.string().uuid() });
export const memberParamSchema = z.object({ id: z.string().uuid(), userId: z.string().min(1) });
export const invitationParamSchema = z.object({
  id: z.string().uuid(),
  invitationId: z.string().min(1),
});
