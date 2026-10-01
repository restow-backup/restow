import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { type FailureRecordJson, timestamps } from "./_shared.js";
import { secrets } from "./secrets.js";
import { tenants } from "./tenants.js";
import { users } from "./users.js";

/**
 * `import` = mail files brought in by upload or from the server-side import
 * folder (docs/IMPORT.md). Its protected objects are imported mailboxes: kind
 * `imap`, whose snapshots use the IMAP backup's manifest format, so restore,
 * preview and download work unchanged. Nothing is ever backed up from it.
 */
export const sourceKindEnum = pgEnum("source_kind", ["m365", "imap", "import"]);

/**
 * Connection health of a source. `pending` = created but not yet usable (M365:
 * admin consent outstanding; IMAP: never connected), `error` = the last
 * sync/probe failed (`error_message` says why), `disabled` = paused by an admin.
 */
export const sourceStatusEnum = pgEnum("source_status", ["pending", "active", "error", "disabled"]);

/** IMAP transport security: implicit TLS (993), STARTTLS (143) or none (dev only). */
export const imapSecurityEnum = pgEnum("imap_security", ["tls", "starttls", "none"]);

export const protectedObjectKindEnum = pgEnum("protected_object_kind", [
  "mailbox",
  "onedrive",
  "imap",
]);

/** Where a protected object came from: automatic directory sync or a manual entry. */
export const protectedObjectOriginEnum = pgEnum("protected_object_origin", [
  "directory_sync",
  "manual",
]);

/** Protection status: actively protected, explicitly excluded, or orphaned
 *  (the underlying mailbox/drive disappeared from the source directory). */
export const protectedObjectStatusEnum = pgEnum("protected_object_status", [
  "active",
  "excluded",
  "orphaned",
]);

/**
 * Whether the per-mailbox IMAP credential in `protected_objects.secret_ref`
 * currently works: `untested` right after it is set, `ok`/`failed` after the
 * next connection attempt. Null (no enum value) means the object uses no
 * per-mailbox credential at all (shared or master-user auth, see
 * `SourceConfig.imapAuthMode`).
 */
export const credentialStatusEnum = pgEnum("credential_status", ["untested", "ok", "failed"]);

/** What kind of account receives the restore-test items of a verification. */
export type VerifyTargetKind = "mailbox" | "onedrive" | "imap";

/**
 * The account a scheduled verification restores sample items into, to prove a
 * real restore works: a mailbox or OneDrive owner (M365) or an IMAP login of the
 * source (`ref`), and the folder the items land in (a default applies when
 * absent). Never the account the items were backed up from.
 */
export type VerifyTarget = {
  kind: VerifyTargetKind;
  ref: string;
  folder?: string;
};

/**
 * Additional non-secret source configuration that has no dedicated column
 * (protection scope rules, IMAP auth flavour, the verification restore target).
 * Secrets NEVER go here — they live in `secrets` and are referenced by `secret_ref`.
 */
export type SourceConfig = {
  // Where verification restores sample items; null or absent = no restore test.
  verifyTarget?: VerifyTarget | null;
  // imap: how the stored secret is used (password vs. OAuth2 refresh token).
  // Unchanged by the addition of imapAuthMode below: it describes the secret's
  // shape, not which mailbox it belongs to.
  authKind?: "password" | "oauth2";
  // imap: which secret backs a mailbox's login. Absent means "shared" (the
  // pre-0.303 behaviour): one secret on the source itself, username = the
  // protected object's external id. "per_mailbox" reads the sealed password
  // from that object's own `secret_ref` instead. "master_user" logs in with one
  // shared master account that impersonates the target mailbox, shaped by
  // `masterUser` below (no per-mailbox secret at all).
  imapAuthMode?: "shared" | "per_mailbox" | "master_user";
  // imap: the master account's login, only meaningful when imapAuthMode is
  // "master_user". `style` picks how the impersonated mailbox is encoded into
  // the login: "dovecot_separator" appends it to the username with `separator`
  // (default "*", e.g. "master*user@example.test"), "sasl_authzid" sends the
  // master's own username/password and authorizes as the mailbox via SASL
  // AUTHZID. The master credential itself still lives in `secrets`, referenced
  // by this source's own `secret_ref` (sources.ts), never here.
  masterUser?: {
    username: string;
    style: "dovecot_separator" | "sasl_authzid";
    separator?: string;
  };
  // imap: a provider admin saved this host although it lies in a loopback or private
  // network. Tenant admins cannot, so their hosts must stay public (docs/IMAP.md);
  // any change of host or port by someone else clears the approval.
  privateNetworkApproval?: { by: string; at: string } | null;
  // m365: which mailboxes/drives to protect (all, a group, an exclusion list).
  scope?: {
    mode?: "all" | "group";
    groupId?: string;
    exclude?: string[];
  };
};

/**
 * Result of the Graph permission check after admin consent: which application
 * permissions the Entra app actually holds in the customer tenant, so the UI
 * can show exactly what is missing (docs/MICROSOFT.md).
 */
export type PermissionsVerified = {
  // ISO-8601 time of the check.
  checkedAt: string;
  granted: string[];
  missing: string[];
};

/** Name of the installation-wide unique index on `sources.entra_tenant_id`. */
export const ENTRA_TENANT_UNIQUE_INDEX = "sources_entra_tenant_uq";

/**
 * A backup/archive source per tenant: an M365 tenant (via app consent) or an
 * IMAP endpoint. M365 columns are null for IMAP sources and vice versa.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: sourceKindEnum("kind").notNull(),
    name: text("name").notNull(),
    status: sourceStatusEnum("status").notNull().default("pending"),
    // Last sync/probe failure, shown to the operator as-is (never contains secrets).
    errorMessage: text("error_message"),
    // The classified cause behind `errorMessage`; null for rows that predate it or a healthy source.
    failure: jsonb("failure").$type<FailureRecordJson>(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    // --- m365 ---
    // Entra tenant id (GUID, lower-case) of the customer tenant that consented to the
    // Restow app, as proven by the admin's sign-in. Unique across the installation.
    entraTenantId: text("entra_tenant_id"),
    consentGrantedAt: timestamp("consent_granted_at", { withTimezone: true }),
    // Who granted admin consent: the UPN (or object id) of the admin whose sign-in proved it.
    consentBy: text("consent_by"),
    permissionsVerified: jsonb("permissions_verified").$type<PermissionsVerified>(),
    // --- imap ---
    host: text("host"),
    port: integer("port"),
    security: imapSecurityEnum("security"),
    username: text("username"),
    // Password / OAuth2 refresh token for IMAP, or the per-source client secret for M365.
    secretRef: uuid("secret_ref").references(() => secrets.id, { onDelete: "set null" }),
    config: jsonb("config").$type<SourceConfig>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("sources_tenant_name_uq").on(t.tenantId, t.name),
    // One Entra tenant belongs to exactly one source of the whole installation:
    // enforced by Postgres regardless of Row Level Security, so no Restow tenant can
    // attach an organisation another tenant already backs up.
    uniqueIndex(ENTRA_TENANT_UNIQUE_INDEX)
      .on(t.entraTenantId)
      .where(sql`${t.entraTenantId} IS NOT NULL`),
  ],
);

/**
 * A mailbox, OneDrive or IMAP account that Restow protects. Belongs to a source
 * and (usually) a directory user. Protection scope follows the tenant's rules
 * (all / group / exclusion list).
 */
export const protectedObjects = pgTable(
  "protected_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: protectedObjectKindEnum("kind").notNull(),
    origin: protectedObjectOriginEnum("origin").notNull().default("directory_sync"),
    status: protectedObjectStatusEnum("status").notNull().default("active"),
    // Stable external identifier: mailbox address, drive id, or IMAP login.
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    /**
     * When this object most recently turned `active` (protection started):
     * set the moment the status transitions from anything else to `active`,
     * left alone by every other update (an object staying active, or a
     * display-name refresh from a directory sync, must not push this out).
     * Null while the object has never been active. The readiness view's
     * first-backup grace period (docs/ARCHITECTURE.md) reads from here, not
     * from `created_at`, so an object created `excluded` and included later
     * is not immediately flagged overdue.
     */
    activeSince: timestamp("active_since", { withTimezone: true }),
    /**
     * The sealed per-mailbox IMAP password (`SourceConfig.imapAuthMode ===
     * "per_mailbox"` on the parent source), never the plaintext: the value lives
     * in `secrets`, sealed with the tenant key exactly like `sources.secret_ref`.
     * Null for every M365 object and for IMAP objects under shared or
     * master-user auth. Deleting the secret clears only this reference, never
     * the object itself; `credentialStatus` is left as it was (stale) until the
     * next credential check or edit updates it.
     */
    secretRef: uuid("secret_ref").references(() => secrets.id, { onDelete: "set null" }),
    /**
     * Whether `secretRef` currently works. Null means this object uses no
     * per-mailbox credential (secretRef is also null then); `untested` right
     * after a credential is set or changed; `ok` / `failed` after the connection
     * check the worker runs next, with the operator-facing cause (never the
     * secret itself) in `credentialError`. The readiness view and the UI use
     * this to show a mailbox as not protected despite an entry existing.
     */
    credentialStatus: credentialStatusEnum("credential_status"),
    credentialCheckedAt: timestamp("credential_checked_at", { withTimezone: true }),
    credentialError: text("credential_error"),
    // The classified cause behind `credentialError` (why the login failed, what to do).
    credentialFailure: jsonb("credential_failure").$type<FailureRecordJson>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("protected_objects_source_external_uq").on(t.sourceId, t.externalId),
    index("protected_objects_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type ProtectedObject = typeof protectedObjects.$inferSelect;
export type NewProtectedObject = typeof protectedObjects.$inferInsert;
export type SourceStatus = (typeof sourceStatusEnum.enumValues)[number];
export type ImapSecurity = (typeof imapSecurityEnum.enumValues)[number];
export type CredentialStatus = (typeof credentialStatusEnum.enumValues)[number];
