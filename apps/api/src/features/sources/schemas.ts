import { z } from "zod";

/**
 * Request schemas for the sources feature (same style as apps/api/src/schemas.ts).
 *
 * Two kinds of source: a Microsoft 365 tenant (connected through admin
 * consent, no secret of its own) and an IMAP mailbox (host, port, security,
 * username and a password that goes straight to the encrypted secret store).
 */

export const sourceKindSchema = z.enum(["m365", "imap"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

/** Implicit TLS (993), STARTTLS (143) or plaintext (development only). */
export const imapSecuritySchema = z.enum(["tls", "starttls", "none"]);
export type ImapSecurity = z.infer<typeof imapSecuritySchema>;

/** The conventional port per security mode; the UI pre-fills it. */
export const DEFAULT_IMAP_PORT: Record<ImapSecurity, number> = {
  tls: 993,
  starttls: 143,
  none: 143,
};

const nameSchema = z.string().trim().min(1).max(200);

/** RFC 1123 hostname or an IPv4/IPv6 literal; never a URL. */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]+$/i;

export const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      HOSTNAME.test(value) || IPV4.test(value) || (value.includes(":") && IPV6.test(value)),
    "Enter a hostname or IP address, not a URL.",
  );

export const portSchema = z.number().int().min(1).max(65535);

/**
 * A tenant id (GUID) or verified domain the customer admin may enter so the
 * consent link lands in the right tenant. Optional: `organizations` works too.
 */
export const entraTenantHintSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i,
    "Enter the tenant id (GUID) or a verified domain such as contoso.onmicrosoft.com.",
  );

/**
 * Initial protection scope for an M365 source (docs/ARCHITECTURE.md, Schutzregeln).
 * Written once at creation in the directory feature's rule format; afterwards
 * the directory feature owns `config.scope` (rules, overrides, shared mailboxes).
 */
export const m365ScopeSchema = z
  .object({
    mode: z.enum(["all", "group"]).default("all"),
    groupId: z.string().trim().min(1).optional(),
    exclude: z.array(z.string().trim().min(1)).max(1000).default([]),
  })
  .refine((scope) => scope.mode !== "group" || scope.groupId !== undefined, {
    message: "A group id is required for the group scope.",
    path: ["groupId"],
  });

export const createM365SourceSchema = z.object({
  kind: z.literal("m365"),
  name: nameSchema,
  /** Pre-fills the consent link; the callback records the authoritative tenant id. */
  entraTenantHint: entraTenantHintSchema.optional(),
  scope: m365ScopeSchema.optional(),
});
export type CreateM365SourceInput = z.infer<typeof createM365SourceSchema>;

/** Connection fields shared by create, update and the inline test. */
export const imapConnectionSchema = z.object({
  host: hostSchema,
  port: portSchema,
  security: imapSecuritySchema,
  username: z.string().trim().min(1).max(320),
});
export type ImapConnectionInput = z.infer<typeof imapConnectionSchema>;

/**
 * How the mailboxes of an IMAP source authenticate (docs/IMAP.md):
 *   - `shared` (default): one login/password on the source, used for every
 *     mailbox (the login is each mailbox's external id).
 *   - `per_mailbox`: every mailbox has its own password, sealed on its own
 *     protected object; hosters with one password per mailbox and no master
 *     user (Hetzner, IONOS, all-inkl).
 *   - `master_user`: one master account impersonates every mailbox, shaped by
 *     {@link masterUserSchema}.
 */
export const imapAuthModeSchema = z.enum(["shared", "per_mailbox", "master_user"]);
export type ImapAuthMode = z.infer<typeof imapAuthModeSchema>;

/**
 * The master account's login shape for `master_user` auth: `dovecot_separator`
 * appends the mailbox to the master's username with `separator` (default "*"),
 * `sasl_authzid` sends the master's own login and authorizes as the mailbox
 * through SASL PLAIN AUTHZID. The master's own password is the source's
 * `password` field, same as `shared` mode.
 */
export const masterUserSchema = z.object({
  username: z.string().trim().min(1).max(320),
  style: z.enum(["dovecot_separator", "sasl_authzid"]),
  separator: z.string().trim().min(1).max(4).optional(),
});
export type MasterUserInput = z.infer<typeof masterUserSchema>;

export const createImapSourceSchema = imapConnectionSchema.extend({
  kind: z.literal("imap"),
  name: nameSchema,
  // Secret: accepted here, sealed into the secret store, never persisted elsewhere.
  // Required for `shared` and `master_user` (the master's own credential);
  // meaningless for `per_mailbox`, where every mailbox seals its own password
  // instead (the service refuses one here if the mode is `per_mailbox`).
  password: z.string().min(1).max(4096).optional(),
  imapAuthMode: imapAuthModeSchema.default("shared"),
  masterUser: masterUserSchema.optional(),
});
export type CreateImapSourceInput = z.infer<typeof createImapSourceSchema>;

export const createSourceSchema = z.discriminatedUnion("kind", [
  createM365SourceSchema,
  createImapSourceSchema,
]);
export type CreateSourceInput = z.infer<typeof createSourceSchema>;

/** Operators may pause (`disabled`) or resume (`active`) a source; other states are derived. */
export const sourceToggleStatusSchema = z.enum(["active", "disabled"]);

/**
 * Changes an operator may make. The protection scope is not among them: after
 * creation it belongs to the directory feature. A new password replaces the
 * stored secret; it is mandatory when host or username change (see service).
 */
export const updateSourceSchema = z
  .object({
    name: nameSchema.optional(),
    status: sourceToggleStatusSchema.optional(),
    entraTenantHint: entraTenantHintSchema.nullable().optional(),
    host: hostSchema.optional(),
    port: portSchema.optional(),
    security: imapSecuritySchema.optional(),
    username: z.string().trim().min(1).max(320).optional(),
    password: z.string().min(1).max(4096).optional(),
    imapAuthMode: imapAuthModeSchema.optional(),
    // Replaces the master-user shape wholesale; null clears it (back to no master user).
    masterUser: masterUserSchema.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "Nothing to update." });
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;

/**
 * Inline IMAP test from the form, before anything is saved. Either the form
 * carries the password, or it names the stored source whose password may be
 * reused — only for that source's own host and username.
 */
export const imapTestSchema = imapConnectionSchema
  .extend({
    password: z.string().min(1).max(4096).optional(),
    sourceId: z.string().uuid().optional(),
  })
  .refine((input) => input.password !== undefined || input.sourceId !== undefined, {
    message: "A password is required.",
    path: ["password"],
  });
export type ImapTestInput = z.infer<typeof imapTestSchema>;

/**
 * Target of a consent link: a tenant id or domain, `null` for "the admin picks
 * their organisation", or omitted to reuse the stored hint.
 */
export const consentLinkSchema = z
  .object({ tenant: entraTenantHintSchema.nullable().optional() })
  .strict()
  .optional();

export const sourceIdParamSchema = z.object({ id: z.string().uuid() });
