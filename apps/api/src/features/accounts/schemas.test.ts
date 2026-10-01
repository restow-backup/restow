import { describe, expect, it } from "vitest";
import {
  accountUserParamSchema,
  listAccountsQuerySchema,
  provisionAccountSchema,
  setPasswordSchema,
  setPasswordTokenParamSchema,
  tenantIdParamSchema,
} from "./schemas.js";

describe("provisionAccountSchema", () => {
  it("accepts an email and role, lower-cases the email, and makes the name optional", () => {
    const parsed = provisionAccountSchema.parse({
      email: "Jane.Doe@Contoso.Example",
      role: "tenant_admin",
    });
    expect(parsed).toEqual({ email: "jane.doe@contoso.example", role: "tenant_admin" });

    const withName = provisionAccountSchema.parse({
      email: "a@b.co",
      name: "Jane Doe",
      role: "tenant_user",
    });
    expect(withName.name).toBe("Jane Doe");
  });

  it("rejects an invalid email or an unknown role", () => {
    expect(provisionAccountSchema.safeParse({ email: "nope", role: "tenant_user" }).success).toBe(
      false,
    );
    expect(provisionAccountSchema.safeParse({ email: "a@b.co", role: "owner" }).success).toBe(
      false,
    );
  });
});

describe("param schemas", () => {
  it("requires a UUID tenant id", () => {
    expect(tenantIdParamSchema.safeParse({ tenantId: "not-a-uuid" }).success).toBe(false);
    expect(
      tenantIdParamSchema.safeParse({ tenantId: "11111111-1111-1111-1111-111111111111" }).success,
    ).toBe(true);
  });

  it("requires a tenant id and a non-empty user id", () => {
    const ok = accountUserParamSchema.safeParse({
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "user-1",
    });
    expect(ok.success).toBe(true);
    expect(accountUserParamSchema.safeParse({ tenantId: "nope", userId: "user-1" }).success).toBe(
      false,
    );
  });

  it("requires a non-empty token", () => {
    expect(setPasswordTokenParamSchema.safeParse({ token: "" }).success).toBe(false);
    expect(setPasswordTokenParamSchema.safeParse({ token: "abc" }).success).toBe(true);
  });
});

describe("listAccountsQuerySchema", () => {
  it("defaults to no explicit limit, coerces a numeric string, and rejects out-of-range values", () => {
    expect(listAccountsQuerySchema.parse({})).toEqual({});
    expect(listAccountsQuerySchema.parse({ limit: "25" })).toEqual({ limit: 25 });
    expect(listAccountsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listAccountsQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
  });
});

describe("setPasswordSchema", () => {
  it("enforces the emergency-path password policy", () => {
    expect(setPasswordSchema.safeParse({ token: "abc", password: "short" }).success).toBe(false);
    expect(
      setPasswordSchema.safeParse({ token: "abc", password: "correct-horse-battery" }).success,
    ).toBe(true);
  });
});
