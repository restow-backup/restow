import { z } from "zod";
import { localConfigSchema, s3ConfigSchema, s3CredentialsSchema } from "../storage/schemas.js";

/**
 * Request schemas for the installation settings (same style as
 * apps/api/src/schemas.ts). Issue messages are short machine-readable reasons
 * (`required`, `email`, `httpsRequired`, ...) that the web UI maps onto its
 * translations; they are never shown verbatim.
 */

export const OPERATING_MODES = ["local", "public"] as const;
export type OperatingModeOption = (typeof OPERATING_MODES)[number];

/** SMTP connection security as the API contract names it (`tls` = implicit TLS). */
export const SMTP_SECURITY = ["starttls", "tls", "none"] as const;
export type SmtpSecurityOption = (typeof SMTP_SECURITY)[number];

// --- Public URL -----------------------------------------------------------------

/** Why a public URL cannot be used. */
export type PublicUrlReason = "url" | "httpsRequired" | "originOnly" | "domainRequired";

export type PublicUrlCheck = { ok: true; origin: string } | { ok: false; reason: PublicUrlReason };

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IPV4_HOSTNAME = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isIpLiteral(hostname: string): boolean {
  return IPV4_HOSTNAME.test(hostname) || hostname.startsWith("[");
}

/**
 * Validate a public URL and reduce it to its origin. The public URL is the
 * address browsers open, so it must be:
 *   - HTTPS (plain HTTP only for the marked `localhost` development exception),
 *   - a bare origin (Restow is served from the root; a path would be dropped),
 *   - a domain name: WebAuthn cannot bind passkeys to an IP address.
 */
export function checkPublicUrl(value: string): PublicUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, reason: "url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "url" };
  }
  const isLocal = LOCAL_HOSTNAMES.has(parsed.hostname);
  if (parsed.protocol === "http:" && !isLocal) {
    return { ok: false, reason: "httpsRequired" };
  }
  const hasExtras =
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "";
  if (hasExtras) {
    return { ok: false, reason: "originOnly" };
  }
  if (!isLocal && isIpLiteral(parsed.hostname)) {
    return { ok: false, reason: "domainRequired" };
  }
  return { ok: true, origin: parsed.origin };
}

/** A public URL, normalized to its origin (`https://restow.example.com`). */
export const publicUrlSchema = z
  .string()
  .trim()
  .min(1, "required")
  .max(2048, "url")
  .transform((value, ctx) => {
    const result = checkPublicUrl(value);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.reason });
      return z.NEVER;
    }
    return result.origin;
  });

// --- Mail transport ---------------------------------------------------------------

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:.]+$/i;

/** A DNS host name, an IPv4 address or an IPv6 address (without brackets). */
export function isValidHost(value: string): boolean {
  const host = value.trim();
  if (host.length === 0 || host.length > 253) {
    return false;
  }
  return HOSTNAME.test(host) || IPV4.test(host) || (host.includes(":") && IPV6.test(host));
}

const TENANT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** An Entra tenant, named by its id (GUID) or one of its verified domains. */
export function isValidTenantId(value: string): boolean {
  return TENANT_GUID.test(value) || TENANT_DOMAIN.test(value);
}

/** Empty strings and null both mean "not set". */
function emptyToNull(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export const smtpInputSchema = z
  .object({
    host: z.string().trim().refine(isValidHost, "host"),
    port: z
      .number({ required_error: "port", invalid_type_error: "port" })
      .int("port")
      .min(1, "port")
      .max(65535, "port"),
    security: z.enum(SMTP_SECURITY),
    from: z.string().trim().email("email").max(320, "email"),
    /** Omit (or send empty) for a relay without authentication. */
    username: z.string().trim().max(320, "required").nullish().transform(emptyToNull),
    /**
     * Secret: handed to the encrypted secret store, never persisted to `settings`
     * and never returned. Omit to keep the stored password (same host and user).
     */
    password: z
      .string()
      .max(1024, "required")
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
  })
  .strict();
export type SmtpInput = z.infer<typeof smtpInputSchema>;

/** Where Graph sendMail gets its app registration from. */
export const GRAPH_MAIL_APPS = ["backup", "own"] as const;
export type GraphMailAppOption = (typeof GRAPH_MAIL_APPS)[number];

/** Write-only secret text: empty means "keep the stored one". */
function optionalSecret(max: number, reason: string) {
  return z
    .string()
    .max(max, reason)
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined));
}

/**
 * The notification mail's own app registration (Microsoft 365). The client
 * secret or certificate is write-only: omit it to keep the stored one, which
 * is only reused for the same tenant, client id and credential kind.
 */
export const graphOwnAppInputSchema = z
  .object({
    clientId: z.string().trim().regex(TENANT_GUID, "guid"),
    credentialKind: z.enum(["secret", "certificate"]),
    clientSecret: optionalSecret(1024, "clientSecret"),
    /** One PEM with the private key and the certificate. */
    certificatePem: optionalSecret(32_768, "certificate"),
  })
  .strict()
  .superRefine((input, ctx) => {
    // The classic mix-up: the portal's "Secret ID" (a GUID) instead of its "Value".
    if (
      input.credentialKind === "secret" &&
      input.clientSecret !== undefined &&
      TENANT_GUID.test(input.clientSecret.trim())
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["clientSecret"], message: "secretIsId" });
    }
  });
export type GraphOwnAppInput = z.infer<typeof graphOwnAppInputSchema>;

export const graphInputSchema = z
  .object({
    sender: z.string().trim().email("email").max(320, "email"),
    /** Entra tenant for client-credentials sendMail; falls back to GRAPH_MAIL_TENANT_ID. */
    tenantId: z
      .string()
      .trim()
      .max(253, "tenantId")
      .nullish()
      .transform(emptyToNull)
      .refine((value) => value === null || isValidTenantId(value), "tenantId"),
    /** `backup` (the default, as before) or the notification mail's own app. */
    app: z.enum(GRAPH_MAIL_APPS).default("backup"),
    ownApp: graphOwnAppInputSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.app !== "own") {
      return;
    }
    if (!value.ownApp) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownApp"], message: "required" });
    }
    // The own app's token endpoint is addressed by the directory (tenant) ID
    // the app's overview page shows; no environment default applies.
    if (value.tenantId === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tenantId"], message: "required" });
    } else if (!TENANT_GUID.test(value.tenantId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tenantId"], message: "tenantGuid" });
    }
  });
export type GraphInput = z.infer<typeof graphInputSchema>;

/**
 * Google Workspace: a service account with domain-wide delegation sends as
 * `sender`. The key (the JSON file Google hands out) is write-only: omit it
 * to keep the stored one.
 */
export const googleInputSchema = z
  .object({
    sender: z.string().trim().email("email").max(320, "email"),
    serviceAccountKey: optionalSecret(16_384, "serviceAccountKey"),
  })
  .strict();
export type GoogleInput = z.infer<typeof googleInputSchema>;

/** The complete desired mail transport (only the stored secrets may be omitted). */
export const mailInputSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("smtp"), smtp: smtpInputSchema }).strict(),
  z.object({ transport: z.literal("graph"), graph: graphInputSchema }).strict(),
  z.object({ transport: z.literal("google"), google: googleInputSchema }).strict(),
]);
export type MailInput = z.infer<typeof mailInputSchema>;

// --- Requests -----------------------------------------------------------------------

/**
 * PATCH /settings. Every member is optional; a present `mail` replaces the whole
 * transport configuration. `publicUrl: null` clears the URL (local mode only).
 */
export const updateSettingsSchema = z
  .object({
    operatingMode: z.enum(OPERATING_MODES).optional(),
    publicUrl: publicUrlSchema.nullable().optional(),
    mail: mailInputSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "empty",
  });
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/**
 * POST /settings/mail/test. Without `mail` the stored transport is tested;
 * with it, the (unsaved) draft is. `to` defaults to the signed-in admin.
 */
export const mailTestSchema = z
  .object({
    to: z.string().trim().email("email").max(320, "email").optional(),
    mail: mailInputSchema.optional(),
  })
  .strict();
export type MailTestInput = z.infer<typeof mailTestSchema>;

/** Body of `PUT /settings/mail/not-needed`: mark the notification mail as not needed, or take the mark back. */
export const mailNotNeededSchema = z.object({ notNeeded: z.boolean() }).strict();
export type MailNotNeededInput = z.infer<typeof mailNotNeededSchema>;

// --- Default storage ------------------------------------------------------------

/**
 * The installation default storage saved under Installation → Default storage
 * (default-storage.ts): a local path or an S3-compatible bucket, with the same
 * fields as a tenant's storage target. The S3 key pair is write-only: without
 * one, the saved pair is kept as long as the endpoint stays the same.
 */
export const saveDefaultStorageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), config: localConfigSchema }).strict(),
  z
    .object({
      kind: z.literal("s3"),
      config: s3ConfigSchema,
      credentials: s3CredentialsSchema.optional(),
    })
    .strict(),
]);
export type SaveDefaultStorageInput = z.infer<typeof saveDefaultStorageSchema>;
