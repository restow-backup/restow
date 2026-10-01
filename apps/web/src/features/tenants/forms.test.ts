import type { FieldError } from "react-hook-form";
import { describe, expect, it } from "vitest";

import {
  WIZARD_LENGTH_LIMITS,
  customerDataFormFrom,
  editTenantFormFrom,
  editTenantSchema,
  emptyContact,
  emptyRecipient,
  emptyTenantWizardForm,
  fieldMessageKey,
  inviteMemberSchema,
  tenantWizardSchema,
  toCreateTenantInput,
  toUpdateTenantCustomerInput,
  toUpdateTenantInput,
} from "./forms";
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH } from "./slug";
import type { TenantCustomer } from "./types";

/** The reason code shown per field: the first issue wins, as in `zodResolver`. */
function reasons(result: {
  success: boolean;
  error?: { issues: { path: (string | number)[]; message: string }[] };
}) {
  const shown: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    const field = issue.path.join(".");
    shown[field] ??= issue.message;
  }
  return shown;
}

describe("editTenantSchema and toUpdateTenantInput", () => {
  const current = { name: "Example Ltd", mailboxCap: 50 };

  it("starts from the stored values", () => {
    expect(editTenantFormFrom(current)).toEqual({ name: "Example Ltd", mailboxCap: "50" });
    expect(editTenantFormFrom({ name: "A", mailboxCap: null })).toEqual({
      name: "A",
      mailboxCap: "",
    });
  });

  it("accepts an empty cap or a whole number only", () => {
    expect(editTenantSchema.safeParse({ name: "A", mailboxCap: "" }).success).toBe(true);
    expect(editTenantSchema.safeParse({ name: "A", mailboxCap: " 250 " }).success).toBe(true);
    for (const cap of ["-1", "2.5", "ten", "99999999"]) {
      expect(reasons(editTenantSchema.safeParse({ name: "A", mailboxCap: cap })), cap).toEqual({
        mailboxCap: "capInteger",
      });
    }
  });

  it("sends only what changed", () => {
    expect(toUpdateTenantInput({ name: "Example Ltd", mailboxCap: "50" }, current)).toEqual({});
    expect(toUpdateTenantInput({ name: " New Name ", mailboxCap: "50" }, current)).toEqual({
      name: "New Name",
    });
    expect(toUpdateTenantInput({ name: "Example Ltd", mailboxCap: "" }, current)).toEqual({
      mailboxCap: null,
    });
    expect(toUpdateTenantInput({ name: "Example Ltd", mailboxCap: "0" }, current)).toEqual({
      mailboxCap: 0,
    });
  });
});

describe("inviteMemberSchema", () => {
  it("requires a valid email and a tenant role", () => {
    expect(
      inviteMemberSchema.safeParse({ email: " ada@example.org ", role: "tenant_admin" }),
    ).toEqual({ success: true, data: { email: "ada@example.org", role: "tenant_admin" } });
    expect(reasons(inviteMemberSchema.safeParse({ email: "", role: "tenant_user" }))).toEqual({
      email: "required",
    });
    expect(reasons(inviteMemberSchema.safeParse({ email: "nope", role: "tenant_user" }))).toEqual({
      email: "email",
    });
    expect(inviteMemberSchema.safeParse({ email: "a@b.de", role: "provider_admin" }).success).toBe(
      false,
    );
  });
});

describe("tenantWizardSchema", () => {
  function validValues() {
    return {
      ...emptyTenantWizardForm("de"),
      name: "Contoso GmbH",
      slug: "contoso",
      contacts: [{ ...emptyContact(true), name: "Alice" }],
    };
  }

  it("accepts the minimal wizard values (one primary contact, no recipients or admins)", () => {
    expect(tenantWizardSchema.safeParse(validValues()).success).toBe(true);
  });

  it("requires at least one contact and exactly one primary", () => {
    expect(reasons(tenantWizardSchema.safeParse({ ...validValues(), contacts: [] }))).toEqual({
      contacts: "atLeastOneContact",
    });
    expect(
      reasons(
        tenantWizardSchema.safeParse({
          ...validValues(),
          contacts: [
            { ...emptyContact(true), name: "Alice" },
            { ...emptyContact(true), name: "Bob" },
          ],
        }),
      ),
    ).toEqual({ contacts: "onePrimaryContact" });
  });

  it("rejects a malformed country code but accepts it blank", () => {
    expect(
      reasons(tenantWizardSchema.safeParse({ ...validValues(), countryCode: "Deutschland" })),
    ).toEqual({ countryCode: "countryCodeFormat" });
    expect(tenantWizardSchema.safeParse({ ...validValues(), countryCode: "" }).success).toBe(true);
    expect(tenantWizardSchema.safeParse({ ...validValues(), countryCode: "de" }).success).toBe(
      true,
    );
  });

  it("rejects duplicate notification recipient and admin addresses", () => {
    expect(
      reasons(
        tenantWizardSchema.safeParse({
          ...validValues(),
          notificationRecipients: [
            { ...emptyRecipient(), email: "ops@contoso.example" },
            { ...emptyRecipient(), email: "OPS@contoso.example" },
          ],
        }),
      ),
    ).toEqual({ notificationRecipients: "duplicateEmail" });
  });

  it("caps free-text fields and reports the reason as tooLong", () => {
    expect(
      reasons(tenantWizardSchema.safeParse({ ...validValues(), customerNumber: "x".repeat(65) })),
    ).toEqual({ customerNumber: "tooLong" });
  });

  it("reports a too-short or too-long slug with the reason WIZARD_LENGTH_LIMITS.slug interpolates", () => {
    expect(reasons(tenantWizardSchema.safeParse({ ...validValues(), slug: "a" }))).toEqual({
      slug: "slugTooShort",
    });
    expect(
      reasons(tenantWizardSchema.safeParse({ ...validValues(), slug: "a".repeat(64) })),
    ).toEqual({ slug: "slugTooLong" });
  });
});

describe("WIZARD_LENGTH_LIMITS.slug", () => {
  it("takes its bounds from the slug module instead of duplicating the literals", () => {
    expect(WIZARD_LENGTH_LIMITS.slug).toEqual({ min: SLUG_MIN_LENGTH, max: SLUG_MAX_LENGTH });
  });
});

describe("toCreateTenantInput", () => {
  it("trims blanks to undefined and keeps the entered data", () => {
    const values = {
      ...emptyTenantWizardForm("de"),
      name: " Contoso GmbH ",
      slug: " contoso ",
      customerNumber: "  ",
      vatId: " DE123456789 ",
      contacts: [{ ...emptyContact(true), name: " Alice ", role: "", email: "", phone: "" }],
      notificationRecipients: [{ email: " ops@contoso.example ", name: "", categories: [] }],
    };
    const input = toCreateTenantInput(values);
    expect(input.name).toBe("Contoso GmbH");
    expect(input.slug).toBe("contoso");
    expect(input.customer).toMatchObject({ customerNumber: undefined, vatId: "DE123456789" });
    expect(input.contacts).toEqual([
      { name: "Alice", role: undefined, email: undefined, phone: undefined, isPrimary: true },
    ]);
    expect(input.notificationRecipients).toEqual([
      { email: "ops@contoso.example", name: undefined, categories: [] },
    ]);
  });
});

describe("customerDataFormFrom and toUpdateTenantCustomerInput", () => {
  const unset: TenantCustomer = {
    customerNumber: null,
    vatId: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    countryCode: null,
    language: null,
    timeZone: null,
  };

  it("falls back to the UI language only for display, not as the stored value", () => {
    expect(customerDataFormFrom(unset, "de").language).toBe("de");
    expect(customerDataFormFrom({ ...unset, language: "en" }, "de").language).toBe("en");
  });

  it("sends nothing for an untouched language field, even though the form displays the viewer's UI language as a fallback", () => {
    // customerDataFormFrom fills the field with "en" only so the Select has
    // something to show; saving the rest of the form unchanged must not
    // silently adopt it as the tenant's language.
    const values = customerDataFormFrom(unset, "en");
    expect(toUpdateTenantCustomerInput(values, unset)).toEqual({});
    expect(toUpdateTenantCustomerInput(values, unset, false)).toEqual({});
  });

  it("sends the language on a first save once the field was actually touched", () => {
    const values = customerDataFormFrom(unset, "en");
    expect(toUpdateTenantCustomerInput(values, unset, true)).toEqual({ language: "en" });
  });

  it("sends nothing when the language already matches", () => {
    const current = { ...unset, language: "en" as const };
    const values = customerDataFormFrom(current, "de");
    expect(toUpdateTenantCustomerInput(values, current)).toEqual({});
  });

  it("sends the language again once it is actually changed, even without the touched flag (the tenant already has one on file)", () => {
    const current = { ...unset, language: "en" as const };
    const values = { ...customerDataFormFrom(current, "en"), language: "de" as const };
    expect(toUpdateTenantCustomerInput(values, current)).toEqual({ language: "de" });
  });

  it("lower-cases in the form become the stored upper-case country code as a change", () => {
    const current = { ...unset, countryCode: "DE", language: "de" as const };
    const values = { ...customerDataFormFrom(current, "de"), countryCode: "de" };
    // The form does not normalize case itself (the API does); typing the same
    // country in lower case is still seen as a real change to send.
    expect(toUpdateTenantCustomerInput(values, current)).toEqual({ countryCode: "de" });
  });

  it("clears a field back to null when it is emptied", () => {
    const current = { ...unset, city: "Bergisch Gladbach", language: "de" as const };
    const values = { ...customerDataFormFrom(current, "de"), city: "" };
    expect(toUpdateTenantCustomerInput(values, current)).toEqual({ city: null });
  });

  it("sends only the fields that actually changed", () => {
    const current: TenantCustomer = { ...unset, city: "Cologne", language: "de" };
    const values = { ...customerDataFormFrom(current, "de"), city: "Bergisch Gladbach" };
    expect(toUpdateTenantCustomerInput(values, current)).toEqual({ city: "Bergisch Gladbach" });
  });
});

describe("fieldMessageKey", () => {
  const error = (message: string): FieldError => ({ type: "custom", message });

  it("uses the feature's own messages and the shared ones", () => {
    expect(fieldMessageKey(error("slugTaken"))).toBe("tenants:validation.slugTaken");
    expect(fieldMessageKey(error("email"))).toBe("common:validation.email");
    expect(fieldMessageKey(error("Invalid enum value"))).toBe("common:validation.required");
    expect(fieldMessageKey(undefined)).toBeUndefined();
  });
});
