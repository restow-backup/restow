import { describe, expect, it } from "vitest";
import {
  addMemberSchema,
  countryCodeSchema,
  createTenantSchema,
  customerDataSchema,
  replaceNotificationRecipientsSchema,
  replaceTenantContactsSchema,
  tenantSlugSchema,
  updateTenantSchema,
} from "./schemas.js";

function contact(overrides: Partial<{ name: string; isPrimary: boolean }> = {}) {
  return { name: "Alice", isPrimary: false, ...overrides };
}

describe("tenantSlugSchema", () => {
  it("accepts lowercase, digits and single hyphens", () => {
    expect(tenantSlugSchema.safeParse("contoso").success).toBe(true);
    expect(tenantSlugSchema.safeParse("contoso-gmbh-2").success).toBe(true);
    expect(tenantSlugSchema.safeParse(" acme ").success).toBe(true);
  });

  it("rejects uppercase, spaces, leading/trailing/double hyphens and short values", () => {
    for (const slug of [
      "Contoso",
      "con toso",
      "-contoso",
      "contoso-",
      "con--toso",
      "a",
      "ünïcode",
    ]) {
      expect(tenantSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });
});

describe("createTenantSchema / updateTenantSchema", () => {
  it("requires name and slug", () => {
    expect(createTenantSchema.safeParse({ name: "Contoso", slug: "contoso" }).success).toBe(true);
    expect(createTenantSchema.safeParse({ name: "", slug: "contoso" }).success).toBe(false);
    expect(createTenantSchema.safeParse({ name: "Contoso" }).success).toBe(false);
  });

  it("rejects an empty patch and the deleting status", () => {
    expect(updateTenantSchema.safeParse({}).success).toBe(false);
    expect(updateTenantSchema.safeParse({ status: "deleting" }).success).toBe(false);
    expect(updateTenantSchema.safeParse({ status: "suspended" }).success).toBe(true);
    expect(updateTenantSchema.safeParse({ mailboxCap: null }).success).toBe(true);
    expect(updateTenantSchema.safeParse({ mailboxCap: -1 }).success).toBe(false);
  });
});

describe("addMemberSchema", () => {
  it("accepts the two tenant roles only", () => {
    expect(addMemberSchema.safeParse({ email: "a@b.co", role: "tenant_admin" }).success).toBe(true);
    expect(addMemberSchema.safeParse({ email: "a@b.co", role: "tenant_user" }).success).toBe(true);
    expect(addMemberSchema.safeParse({ email: "a@b.co", role: "owner" }).success).toBe(false);
    expect(addMemberSchema.safeParse({ email: "nope", role: "tenant_user" }).success).toBe(false);
  });
});

describe("replaceTenantContactsSchema", () => {
  it("accepts an empty list (no contacts yet)", () => {
    expect(replaceTenantContactsSchema.safeParse([]).success).toBe(true);
  });

  it("accepts exactly one primary contact", () => {
    const result = replaceTenantContactsSchema.safeParse([
      contact({ isPrimary: true }),
      contact({ name: "Bob" }),
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects a non-empty list with no primary contact", () => {
    const result = replaceTenantContactsSchema.safeParse([contact(), contact({ name: "Bob" })]);
    expect(result.success).toBe(false);
    expect(result.success ? null : result.error.issues[0]?.message).toBe("onePrimaryContact");
  });

  it("rejects two primary contacts", () => {
    const result = replaceTenantContactsSchema.safeParse([
      contact({ isPrimary: true }),
      contact({ name: "Bob", isPrimary: true }),
    ]);
    expect(result.success).toBe(false);
    expect(result.success ? null : result.error.issues[0]?.message).toBe("onePrimaryContact");
  });
});

describe("replaceNotificationRecipientsSchema", () => {
  it("rejects the same address twice, case-insensitively", () => {
    const result = replaceNotificationRecipientsSchema.safeParse([
      { email: "ops@contoso.example", categories: [] },
      { email: "OPS@contoso.example", categories: ["jobFailures"] },
    ]);
    expect(result.success).toBe(false);
    expect(result.success ? null : result.error.issues[0]?.message).toBe("duplicateRecipient");
  });

  it("accepts distinct addresses", () => {
    const result = replaceNotificationRecipientsSchema.safeParse([
      { email: "ops@contoso.example", categories: ["jobFailures"] },
      { email: "billing@contoso.example", categories: [] },
    ]);
    expect(result.success).toBe(true);
  });
});

describe("countryCodeSchema / customerDataSchema time zone", () => {
  it("upper-cases a two-letter code and rejects anything else", () => {
    expect(countryCodeSchema.safeParse("de")).toMatchObject({ success: true, data: "DE" });
    expect(countryCodeSchema.safeParse("deu").success).toBe(false);
    expect(countryCodeSchema.safeParse("1a").success).toBe(false);
  });

  it("accepts a real IANA time zone and rejects a typo", () => {
    expect(customerDataSchema.safeParse({ timeZone: "Europe/Berlin" }).success).toBe(true);
    expect(customerDataSchema.safeParse({ timeZone: "Berlin" }).success).toBe(false);
  });
});
