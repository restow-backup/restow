import { describe, expect, it } from "vitest";
import { z } from "zod";

import { validationKey, zodResolver } from "./form";

const schema = z.object({
  email: z.string().email("email"),
  admin: z.object({
    name: z.string().min(1, "required"),
    password: z.string().min(12, "minLength"),
  }),
});

describe("zodResolver", () => {
  it("returns parsed values when valid", async () => {
    const resolve = zodResolver(schema);
    const result = await resolve(
      { email: "a@b.de", admin: { name: "A", password: "x".repeat(12) } },
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    expect(result.errors).toEqual({});
    expect(result.values).toMatchObject({ email: "a@b.de" });
  });

  it("nests errors so react-hook-form can find them by path", async () => {
    const resolve = zodResolver(schema);
    const result = await resolve(
      { email: "nope", admin: { name: "", password: "short" } },
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    const errors = result.errors as Record<string, unknown>;
    expect(errors.email).toMatchObject({ message: "email" });
    expect((errors.admin as Record<string, unknown>).name).toMatchObject({ message: "required" });
    expect((errors.admin as Record<string, unknown>).password).toMatchObject({
      message: "minLength",
    });
  });
});

describe("validationKey", () => {
  it("maps known reasons and falls back safely", () => {
    expect(validationKey(undefined)).toBeUndefined();
    expect(validationKey({ type: "custom", message: "email" })).toBe("validation.email");
    expect(validationKey({ type: "too_small", message: "Expected string" })).toBe(
      "validation.required",
    );
  });
});
