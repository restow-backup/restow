import type { FieldError } from "react-hook-form";
import { z } from "zod";

import type { TenantRole } from "@/lib/api";

import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, slugProblem } from "./slug";
import type {
  CreateTenantInput,
  NotificationCategory,
  TenantCustomer,
  TenantDetail,
  UpdateTenantCustomerInput,
  UpdateTenantInput,
} from "./types";

// Re-exported so the wizard's steps and the i18n guard can keep importing the
// category list from the forms module, alongside the wizard schema it validates.
export { NOTIFICATION_CATEGORIES, OFFERED_NOTIFICATION_CATEGORIES } from "./types";

/**
 * Form schemas of the tenants feature. Every issue message is a short reason
 * code; `fieldMessageKey` maps it to a translation key, so zod's English
 * defaults never reach the UI. Limits mirror the API schemas.
 */

export const NAME_MAX_LENGTH = 200;

/** Reasons the shared `common:validation.*` messages already cover. */
const COMMON_REASONS = new Set(["required", "email"]);

/** Reasons with a message of their own in `tenants:validation.*`. */
const TENANT_REASONS = new Set([
  "nameTooLong",
  "slugTooShort",
  "slugTooLong",
  "slugFormat",
  "slugTaken",
  "capInteger",
  "tooLong",
  "countryCodeFormat",
  "timeZoneFormat",
  "onePrimaryContact",
  "atLeastOneContact",
  "duplicateEmail",
  "customerNumberTaken",
]);

/** Namespaced translation key for a field error (usable from any namespace). */
export function fieldMessageKey(error: FieldError | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  const reason = typeof error.message === "string" ? error.message : "";
  if (TENANT_REASONS.has(reason)) {
    return `tenants:validation.${reason}`;
  }
  return `common:validation.${COMMON_REASONS.has(reason) ? reason : "required"}`;
}

const tenantName = z.string().trim().min(1, "required").max(NAME_MAX_LENGTH, "nameTooLong");

// --- Edit -----------------------------------------------------------------------

export interface EditTenantValues {
  name: string;
  /** Text field: empty means "no cap", otherwise a whole number of mailboxes. */
  mailboxCap: string;
}

export const editTenantSchema = z.object({
  name: tenantName,
  mailboxCap: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d{1,7}$/.test(value), "capInteger"),
});

export function editTenantFormFrom(
  tenant: Pick<TenantDetail, "name" | "mailboxCap">,
): EditTenantValues {
  return {
    name: tenant.name,
    mailboxCap: tenant.mailboxCap === null ? "" : String(tenant.mailboxCap),
  };
}

function parseCap(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : Number.parseInt(trimmed, 10);
}

/** Only what changed, so an unchanged save sends nothing and writes no audit entry. */
export function toUpdateTenantInput(
  values: EditTenantValues,
  current: Pick<TenantDetail, "name" | "mailboxCap">,
): UpdateTenantInput {
  const patch: UpdateTenantInput = {};
  const name = values.name.trim();
  if (name !== current.name) {
    patch.name = name;
  }
  const cap = parseCap(values.mailboxCap);
  if (cap !== current.mailboxCap) {
    patch.mailboxCap = cap;
  }
  return patch;
}

// --- Invite ---------------------------------------------------------------------

export interface InviteMemberValues {
  email: string;
  role: TenantRole;
}

export const inviteMemberSchema = z.object({
  email: z.string().trim().min(1, "required").email("email"),
  role: z.enum(["tenant_admin", "tenant_user"]),
});

export function emptyInviteForm(role: TenantRole): InviteMemberValues {
  return { email: "", role };
}

// --- Tenant wizard ----------------------------------------------------------------

export const WIZARD_STEPS = [
  "organisation",
  "contacts",
  "notifications",
  "admins",
  "source",
  "review",
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface TenantWizardContactValues {
  name: string;
  role: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}

export interface TenantWizardRecipientValues {
  email: string;
  name: string;
  categories: NotificationCategory[];
}

export interface TenantWizardAdminValues {
  email: string;
  role: TenantRole;
}

export interface TenantWizardValues {
  name: string;
  slug: string;
  customerNumber: string;
  vatId: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  countryCode: string;
  language: "de" | "en";
  timeZone: string;
  contacts: TenantWizardContactValues[];
  notificationRecipients: TenantWizardRecipientValues[];
  admins: TenantWizardAdminValues[];
}

/** Field names of the wizard's `useForm`, per step; used for `trigger()` on "Next". */
export const WIZARD_STEP_FIELDS: Record<WizardStep, (keyof TenantWizardValues)[]> = {
  organisation: [
    "name",
    "slug",
    "customerNumber",
    "vatId",
    "addressLine1",
    "addressLine2",
    "postalCode",
    "city",
    "countryCode",
    "language",
    "timeZone",
  ],
  contacts: ["contacts"],
  notifications: ["notificationRecipients"],
  admins: ["admins"],
  source: [],
  review: [],
};

const CUSTOMER_NUMBER_MAX = 64;
const VAT_ID_MAX = 32;
const ADDRESS_LINE_MAX = 200;
const POSTAL_CODE_MAX = 20;
const CITY_MAX = 120;
const TIME_ZONE_MAX = 64;
/** Mirror apps/api/src/features/tenants/schemas.ts (tenantContactInputSchema). */
export const CONTACT_ROLE_MAX = 120;
export const PHONE_MAX = 64;
export const CONTACT_EMAIL_MAX = 320;

/** Length limits the "tooLong" (and slug's "slugTooShort") message names, per wizard field. */
export const WIZARD_LENGTH_LIMITS: Partial<
  Record<keyof TenantWizardValues, { min?: number; max: number }>
> = {
  name: { max: NAME_MAX_LENGTH },
  slug: { min: SLUG_MIN_LENGTH, max: SLUG_MAX_LENGTH },
  customerNumber: { max: CUSTOMER_NUMBER_MAX },
  vatId: { max: VAT_ID_MAX },
  addressLine1: { max: ADDRESS_LINE_MAX },
  addressLine2: { max: ADDRESS_LINE_MAX },
  postalCode: { max: POSTAL_CODE_MAX },
  city: { max: CITY_MAX },
  timeZone: { max: TIME_ZONE_MAX },
};

/** Optional text field capped at `max`; blank is valid (the field is simply unset). */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .refine((value) => value.length <= max, "tooLong");
}

const countryCodeField = z
  .string()
  .trim()
  .refine((value) => value === "" || /^[A-Za-z]{2}$/.test(value), "countryCodeFormat");

/** Whether the ICU engine recognizes `value` as a time zone (mirrors the API's check). */
export function isValidTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeZoneField = z
  .string()
  .trim()
  .refine((value) => value.length <= TIME_ZONE_MAX, "tooLong")
  .refine((value) => value === "" || isValidTimeZone(value), "timeZoneFormat");

/** Optional e-mail capped at `max`; blank is valid, same rule as a required email otherwise. */
function optionalEmail(max: number) {
  return z
    .string()
    .trim()
    .refine((value) => value === "" || value.length <= max, "tooLong")
    .refine((value) => value === "" || z.string().trim().email().safeParse(value).success, "email");
}

const wizardContactSchema = z.object({
  name: z.string().trim().min(1, "required").max(NAME_MAX_LENGTH, "tooLong"),
  role: optionalText(CONTACT_ROLE_MAX),
  email: optionalEmail(CONTACT_EMAIL_MAX),
  phone: optionalText(PHONE_MAX),
  isPrimary: z.boolean(),
});

const wizardRecipientSchema = z.object({
  email: z.string().trim().min(1, "required").email("email"),
  name: optionalText(NAME_MAX_LENGTH),
  categories: z.array(z.enum(["jobFailures", "weeklyReport", "readinessRed", "licenseUpdates"])),
});

const wizardAdminSchema = z.object({
  email: z.string().trim().min(1, "required").email("email"),
  role: z.enum(["tenant_admin", "tenant_user"]),
});

function uniqueEmails(entries: readonly { email: string }[]): boolean {
  const seen = new Set(entries.map((entry) => entry.email.trim().toLowerCase()).filter(Boolean));
  return seen.size === entries.filter((entry) => entry.email.trim()).length;
}

export const tenantWizardSchema = z.object({
  name: tenantName,
  slug: z
    .string()
    .trim()
    .superRefine((value, context) => {
      const problem = slugProblem(value);
      if (problem) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }
    }),
  customerNumber: optionalText(CUSTOMER_NUMBER_MAX),
  vatId: optionalText(VAT_ID_MAX),
  addressLine1: optionalText(ADDRESS_LINE_MAX),
  addressLine2: optionalText(ADDRESS_LINE_MAX),
  postalCode: optionalText(POSTAL_CODE_MAX),
  city: optionalText(CITY_MAX),
  countryCode: countryCodeField,
  language: z.enum(["de", "en"]),
  timeZone: timeZoneField,
  contacts: z
    .array(wizardContactSchema)
    .min(1, "atLeastOneContact")
    .refine((contacts) => contacts.filter((contact) => contact.isPrimary).length === 1, {
      message: "onePrimaryContact",
    }),
  notificationRecipients: z
    .array(wizardRecipientSchema)
    .refine(uniqueEmails, { message: "duplicateEmail" }),
  admins: z.array(wizardAdminSchema).refine(uniqueEmails, { message: "duplicateEmail" }),
});

export function emptyContact(isPrimary: boolean): TenantWizardContactValues {
  return { name: "", role: "", email: "", phone: "", isPrimary };
}

export function emptyRecipient(): TenantWizardRecipientValues {
  return { email: "", name: "", categories: [] };
}

export function emptyAdmin(role: TenantRole): TenantWizardAdminValues {
  return { email: "", role };
}

/** The IANA time zone the browser runs in, when it can be read; "" otherwise. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

export function emptyTenantWizardForm(language: "de" | "en"): TenantWizardValues {
  return {
    name: "",
    slug: "",
    customerNumber: "",
    vatId: "",
    addressLine1: "",
    addressLine2: "",
    postalCode: "",
    city: "",
    countryCode: "",
    language,
    timeZone: browserTimeZone(),
    contacts: [emptyContact(true)],
    notificationRecipients: [],
    admins: [],
  };
}

/** Trims `value`; blank becomes `undefined` so an optional field is simply left unset. */
export function undefinedIfBlank(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The wizard's values, reshaped into the API's nested create-tenant request. */
export function toCreateTenantInput(values: TenantWizardValues): CreateTenantInput {
  const customer = {
    customerNumber: undefinedIfBlank(values.customerNumber),
    vatId: undefinedIfBlank(values.vatId),
    addressLine1: undefinedIfBlank(values.addressLine1),
    addressLine2: undefinedIfBlank(values.addressLine2),
    postalCode: undefinedIfBlank(values.postalCode),
    city: undefinedIfBlank(values.city),
    countryCode: undefinedIfBlank(values.countryCode),
    language: values.language,
    timeZone: undefinedIfBlank(values.timeZone),
  };
  return {
    name: values.name.trim(),
    slug: values.slug.trim(),
    customer,
    contacts: values.contacts.map((contact) => ({
      name: contact.name.trim(),
      role: undefinedIfBlank(contact.role),
      email: undefinedIfBlank(contact.email),
      phone: undefinedIfBlank(contact.phone),
      isPrimary: contact.isPrimary,
    })),
    notificationRecipients: values.notificationRecipients.map((recipient) => ({
      email: recipient.email.trim(),
      name: undefinedIfBlank(recipient.name),
      categories: recipient.categories,
    })),
  };
}

// --- Customer data panel (tenant detail page) --------------------------------------

export type CustomerDataFormValues = Pick<
  TenantWizardValues,
  | "customerNumber"
  | "vatId"
  | "addressLine1"
  | "addressLine2"
  | "postalCode"
  | "city"
  | "countryCode"
  | "language"
  | "timeZone"
>;

export const customerDataFormSchema = tenantWizardSchema.pick({
  customerNumber: true,
  vatId: true,
  addressLine1: true,
  addressLine2: true,
  postalCode: true,
  city: true,
  countryCode: true,
  language: true,
  timeZone: true,
});

export function customerDataFormFrom(
  customer: TenantCustomer,
  fallbackLanguage: "de" | "en",
): CustomerDataFormValues {
  return {
    customerNumber: customer.customerNumber ?? "",
    vatId: customer.vatId ?? "",
    addressLine1: customer.addressLine1 ?? "",
    addressLine2: customer.addressLine2 ?? "",
    postalCode: customer.postalCode ?? "",
    city: customer.city ?? "",
    countryCode: customer.countryCode ?? "",
    language: customer.language ?? fallbackLanguage,
    timeZone: customer.timeZone ?? "",
  };
}

const CUSTOMER_TEXT_FIELDS = [
  "customerNumber",
  "vatId",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "countryCode",
  "timeZone",
] as const;

/**
 * Only what changed, so an unchanged save sends nothing and writes no audit
 * entry. `languageTouched` is the form's own `formState.dirtyFields.language`
 * (or any equivalent flag): for a tenant with no language set yet,
 * `customerDataFormFrom` fills the field with the viewer's own UI language
 * only so it has something to display, not as a value the tenant now owns —
 * saving the rest of the form unchanged must not silently adopt whichever
 * language the person editing happened to be using. Once the tenant already
 * has a language, any real change is sent regardless, the same as every
 * other field.
 */
export function toUpdateTenantCustomerInput(
  values: CustomerDataFormValues,
  current: TenantCustomer,
  languageTouched = false,
): UpdateTenantCustomerInput {
  const patch: UpdateTenantCustomerInput = {};
  for (const field of CUSTOMER_TEXT_FIELDS) {
    const next = undefinedIfBlank(values[field]) ?? null;
    if (next !== (current[field] ?? null)) {
      patch[field] = next;
    }
  }
  if (values.language !== current.language && (current.language !== null || languageTouched)) {
    patch.language = values.language;
  }
  return patch;
}
