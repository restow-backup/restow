import { z } from "zod";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./lib/password-policy.js";
import { ProblemError } from "./problem.js";

/**
 * Request schemas of the spine (setup wizard) and the validation helpers every
 * route uses. Feature modules keep their own schemas next to their routes
 * (e.g. features/tenants/schemas.ts) in the same style; the integration API
 * defines its operations in routes/v1/*, from which `/api/v1/openapi.json` is
 * generated.
 */

export const operatingModeSchema = z.enum(["local", "public"]);
export const mailTransportSchema = z.enum(["smtp", "graph", "google"]);

// --- Setup wizard -----------------------------------------------------------

/**
 * SMTP connection security. `tls` (implicit TLS, port 465) is the contract's
 * name; `implicit` is accepted as the stored spelling (see db MailConfig).
 */
export const smtpSecuritySchema = z.enum(["starttls", "tls", "implicit", "none"]);
export type SmtpSecurity = z.infer<typeof smtpSecuritySchema>;

/** Normalize the accepted security names onto the stored MailConfig value. */
export function toStoredSmtpSecurity(security: SmtpSecurity): "starttls" | "implicit" | "none" {
  return security === "tls" ? "implicit" : security;
}

export const smtpSetupSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  security: smtpSecuritySchema.default("starttls"),
  from: z.string().trim().email(),
  username: z.string().min(1).optional(),
  // Secret: accepted here, handed to the encrypted secret store, and NEVER
  // persisted to the `settings` row (see packages/db system schema).
  password: z.string().min(1).optional(),
});

export const graphSetupSchema = z.object({
  sender: z.string().trim().email(),
  /** Entra tenant id for client-credentials sendMail; defaults to the environment. */
  tenantId: z.string().trim().min(1).optional(),
});

export const mailSetupSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("smtp"), smtp: smtpSetupSchema }),
  z.object({ transport: z.literal("graph"), graph: graphSetupSchema }),
]);
export type MailSetup = z.infer<typeof mailSetupSchema>;

/** Password policy for the emergency password path (better-auth enforces the same). */
export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH);

export const firstAdminSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  password: passwordSchema,
});

/**
 * Acceptance of the operator responsibility notice (lib/disclaimer.ts). The
 * version is the one the operator was shown; `accepted` must be the literal
 * `true`, so an unticked box can never be recorded as a yes.
 */
export const acceptDisclaimerSchema = z.object({
  version: z.string().trim().min(1).max(64),
  accepted: z.literal(true),
});
export type AcceptDisclaimerRequest = z.infer<typeof acceptDisclaimerSchema>;

/** The languages the setup wizard offers; the language of the operator's own organisation. */
export const setupLanguageSchema = z.enum(["de", "en"]);

export const setupRequestSchema = z
  .object({
    /**
     * The operator responsibility notice, accepted in the wizard's first step
     * and recorded with the new administrator (lib/disclaimer.ts). Required
     * except in demo mode, which counts as accepted; routes/setup.ts checks it
     * before anything else of the body.
     */
    disclaimer: acceptDisclaimerSchema.optional(),
    operatingMode: operatingModeSchema,
    /** Public origin the browser uses (origin only). Required in `public` mode. */
    publicUrl: z.string().trim().url().optional(),
    /**
     * Name of the operator's own organisation, the one that installs and runs
     * this Restow. Stored as the name of the operator (the single `providers`
     * row) and the name of the installation's own organisation, the tenant of
     * kind `internal` the setup creates (features/tenants/internal.ts).
     */
    providerName: z.string().trim().min(1).max(200),
    /**
     * The language the operator chose in the wizard's first step. It becomes the
     * language of the own organisation (`tenants.language`), which the mails and
     * reports of that tenant are written in, and of the setup's own test message.
     * Absent: the tenant defers to the installation default, as before.
     */
    language: setupLanguageSchema.optional(),
    firstAdmin: firstAdminSchema,
    /**
     * The notification mail transport. Optional: the wizard lets the operator set
     * it up later (Installation, Settings, Mail). Without one nothing sends mail
     * and every feature that would says so (an invitation shows its link to copy).
     */
    mail: mailSetupSchema.optional(),
    /** Send a test notification through the configured transport (needs `mail`). */
    sendTest: z.boolean().default(false),
  })
  .superRefine((request, ctx) => {
    if (request.sendTest && !request.mail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sendTest"],
        message: "A test message needs a mail transport; leave sendTest off when mail is skipped.",
      });
    }
  });
export type SetupRequest = z.infer<typeof setupRequestSchema>;

// --- Helpers ----------------------------------------------------------------

/** Parse `data`, or throw a 422 problem carrying the validation issues. */
export function parseOrProblem<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ProblemError(422, "Validation failed", {
      detail: "The request did not match the expected schema.",
      extensions: { issues: result.error.issues },
    });
  }
  return result.data;
}

/** The JSON body, or null when it is missing or malformed. */
export async function readJsonBody(request: { json: () => Promise<unknown> }): Promise<unknown> {
  return request.json().catch(() => null);
}

/** Read and validate a JSON body; a missing or malformed body fails validation too. */
export async function parseJsonBody<S extends z.ZodTypeAny>(
  request: { json: () => Promise<unknown> },
  schema: S,
): Promise<z.infer<S>> {
  return parseOrProblem(schema, await readJsonBody(request));
}
