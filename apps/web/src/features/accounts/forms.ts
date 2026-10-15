import type { DefaultValues, FieldError } from "react-hook-form";
import { z } from "zod";

import { isTenantRole, type TenantRole } from "@/lib/api";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

/**
 * Form models and validation for the accounts feature. Every issue message
 * is a short reason code; `fieldMessageKey` maps it to a `common:validation.*`
 * key, so zod's English defaults never reach the UI (same style as
 * apps/web/src/features/tenants/forms.ts).
 */

/**
 * The role of a new person: always chosen explicitly, never preset, so nobody
 * gets more (or less) access than whoever created them meant to give.
 */
export const chosenTenantRole = z.custom<TenantRole>(isTenantRole, "required");

export const provisionAccountSchema = z.object({
  email: z.string().trim().min(1, "required").email("email"),
  role: chosenTenantRole,
});
export type ProvisionAccountValues = z.infer<typeof provisionAccountSchema>;

/** An empty form: no address and no role chosen yet. */
export function emptyProvisionForm(): DefaultValues<ProvisionAccountValues> {
  return { email: "" };
}

const COMMON_REASONS = new Set(["required", "email"]);

/** Namespaced `common:validation.*` key for a field error. */
export function fieldMessageKey(error: FieldError | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  const reason = typeof error.message === "string" ? error.message : "";
  return `common:validation.${COMMON_REASONS.has(reason) ? reason : "required"}`;
}

export const setPasswordFormSchema = z
  .object({
    password: z.string().min(PASSWORD_MIN_LENGTH, "minLength"),
    confirm: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.password !== values.confirm) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirm"], message: "passwordMismatch" });
    }
  });
export type SetPasswordFormValues = z.infer<typeof setPasswordFormSchema>;
