import { isAllowedAuthorityHost } from "@restow/core";
import { z } from "zod";
import { isValidTenantId } from "../schemas.js";

/**
 * Request schemas for the Microsoft 365 app registration (same style as the
 * other settings schemas). Issue messages are short reasons the web UI maps
 * onto its translations; they never echo a submitted value.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** Longest client secret accepted (Entra issues about 40 characters). */
export const CLIENT_SECRET_MAX_LENGTH = 1024;
/** Longest PEM accepted (a 4096-bit key plus a certificate chain fits easily). */
export const CERTIFICATE_PEM_MAX_LENGTH = 64 * 1024;

export function isGuid(value: string): boolean {
  return GUID.test(value.trim());
}

/** Empty strings and null both mean "not set". */
function emptyToNull(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

/**
 * A recognised Entra authority host (sovereign-cloud login host): must be a
 * bare https origin (no user, path, query or hash) and one of
 * {@link isAllowedAuthorityHost}'s fixed list. Anything else is refused —
 * this value later drives outbound token requests and customer-facing
 * consent links, so it is never a free-form URL (SSRF, phishing).
 */
export function authorityHostOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const bare =
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "";
    return url.protocol === "https:" && bare && isAllowedAuthorityHost(url.origin)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** A calendar date (`2027-03-01`, time ignored) as midnight UTC in ISO 8601; null when invalid. */
export function expiryDate(value: string): string | null {
  if (!DATE.test(value)) {
    return null;
  }
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)
    ? null
    : date.toISOString();
}

/**
 * PUT /settings/microsoft-app. The client secret and the certificate are
 * write-only; leaving both out keeps the stored credential (same app and
 * authority only, see logic.ts).
 */
export const saveMicrosoftAppSchema = z
  .object({
    clientId: z
      .string({ required_error: "required", invalid_type_error: "guid" })
      .trim()
      .min(1, "required")
      .refine(isGuid, "guid")
      .transform((value) => value.toLowerCase()),
    clientSecret: z
      .string({ invalid_type_error: "required" })
      .max(CLIENT_SECRET_MAX_LENGTH, "tooLong")
      .optional()
      .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined)),
    certificatePem: z
      .string({ invalid_type_error: "required" })
      .max(CERTIFICATE_PEM_MAX_LENGTH, "tooLong")
      .optional()
      .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined)),
    /** When the secret expires (from the Entra portal); only kept for a secret. */
    secretExpiresAt: z
      .string({ invalid_type_error: "date" })
      .trim()
      .nullish()
      .transform(emptyToNull)
      .transform((value, ctx) => {
        if (value === null) {
          return null;
        }
        const date = expiryDate(value);
        if (!date) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "date" });
          return z.NEVER;
        }
        return date;
      }),
    /** The app's own directory: tenant id (GUID) or a verified domain. */
    homeTenantId: z
      .string({ invalid_type_error: "tenantId" })
      .trim()
      .max(253, "tenantId")
      .nullish()
      .transform(emptyToNull)
      .refine((value) => value === null || isValidTenantId(value), "tenantId")
      .transform((value) => value?.toLowerCase() ?? null),
    /** Login host for sovereign clouds; empty for the public cloud. */
    authorityHost: z
      .string({ invalid_type_error: "authorityHost" })
      .trim()
      .max(255, "authorityHost")
      .nullish()
      .transform(emptyToNull)
      .transform((value, ctx) => {
        if (value === null) {
          return null;
        }
        const origin = authorityHostOrigin(value);
        if (!origin) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "authorityHost" });
          return z.NEVER;
        }
        return origin;
      }),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.clientSecret !== undefined && input.certificatePem !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["certificatePem"],
        message: "credentialConflict",
      });
    }
    // The classic mix-up: the portal's "Secret ID" (a GUID) instead of its "Value".
    if (input.clientSecret !== undefined && isGuid(input.clientSecret)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["clientSecret"], message: "secretIsId" });
    }
  });
export type SaveMicrosoftAppInput = z.infer<typeof saveMicrosoftAppSchema>;

/**
 * POST /settings/microsoft-app/test. `tenantId` names the directory to test
 * in; without it the saved home tenant is used.
 */
export const testMicrosoftAppSchema = z
  .object({
    tenantId: z
      .string({ invalid_type_error: "tenantId" })
      .trim()
      .max(253, "tenantId")
      .nullish()
      .transform(emptyToNull)
      .refine((value) => value === null || isValidTenantId(value), "tenantId")
      .transform((value) => value?.toLowerCase() ?? null),
  })
  .strict();
export type TestMicrosoftAppInput = z.infer<typeof testMicrosoftAppSchema>;
