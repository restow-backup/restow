import { sql } from "drizzle-orm";
import {
  check,
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

/**
 * `site` = a SharePoint Online site (release 0.4.x): its document libraries,
 * lists and site metadata, discovered tenant-wide through Graph (not through a
 * directory user) and backed up with the OneDrive drive engine per library.
 *
 * `group` = the group mailbox of a Microsoft 365 group or team (release 0.4.5):
 * its calendar and its conversations, discovered through `groups/delta` (no
 * directory user; `external_id` is the group's Entra object id) and backed up
 * with the Exchange engine's calendar phase plus the conversations phase.
 */
export const protectedObjectKindEnum = pgEnum("protected_object_kind", [
  "mailbox",
  "onedrive",
  "imap",
  "site",
  "group",
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
  // imap with authKind "oauth2": whose OAuth2 service issued the token (non-secret; the
  // sealed secret carries the same). "google" makes the source's accounts Google
  // Workspace for the archive's capture ways (packages/db archive-capture.ts captureKindOf).
  oauth2Provider?: "microsoft" | "google" | "custom";
  // imap: whether the archive capture keeps one IMAP IDLE connection open per account
  // (docs/IMAP.md "Archivierung"). Absent = "auto" (IDLE where the server offers it, within
  // the worker's budget); "off" = poll only, for providers with a tight connection limit.
  archiveIdle?: "auto" | "off";
  // m365: whether an administrator confirmed that a retention policy or litigation hold
  // keeps deleted mail in the tenant (docs/ARCHIVE.md, Graph capture). Restow cannot read it
  // from Graph; `unknown` until confirmed (audited `archive.hold.confirmed`).
  archiveHold?: {
    status: "unknown" | "confirmed";
    confirmedBy: string | null;
    confirmedAt: string | null;
  };
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
     * Why an `orphaned` Microsoft 365 object is not backed up although it is still in the
     * directory (0.4.7): `account_disabled` (sign-in blocked and Exchange reports no mailbox),
     * `no_license` (no Exchange Online licence, mailbox inactive) or `locked` (OneDrive or site
     * answers HTTP 423 resourceLocked, as Microsoft does for unlicensed accounts' OneDrives).
     * Null for every other object and for an object removed from the source. Such an object is neutral like
     * any orphaned one (no backups, no overdue, kept snapshots) and turns `active` again by
     * itself once the directory sync finds the mailbox. A trigger clears the reason whenever
     * the status leaves `orphaned` (migration 0069).
     */
    statusReason: text("status_reason").$type<ObjectStatusReason>(),
    /**
     * Confirmation of an object Restow stopped backing up because the source says it is gone,
     * disabled, unlicensed or locked (status `orphaned`, with or without `status_reason`).
     * `inactive_since` is when it last turned `orphaned` (the date the UI shows). Until an admin
     * confirms it (`status_confirmed_at`/`_by`: an address, `api-key:<id>`, or `migration` for
     * objects that were orphaned before 0.4.7) it reads amber "please confirm" and keeps the
     * tenant from green; afterwards grey "intentionally no longer backed up".
     * `inactive_notified_at` marks the one-time notice as raised (apps/worker
     * inactive-notices.ts). The 0069 trigger sets `inactive_since` and clears the confirmation
     * and the notice on every transition into `orphaned`, and clears all four (and
     * `status_reason`) whenever the status leaves it: re-activation drops a confirmation in
     * every write path.
     */
    inactiveSince: timestamp("inactive_since", { withTimezone: true }),
    inactiveNotifiedAt: timestamp("inactive_notified_at", { withTimezone: true }),
    statusConfirmedAt: timestamp("status_confirmed_at", { withTimezone: true }),
    statusConfirmedBy: text("status_confirmed_by"),
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
    check(
      "protected_objects_status_reason_ck",
      sql`${t.statusReason} IS NULL OR ${t.statusReason} IN ('account_disabled', 'no_license', 'locked')`,
    ),
    // Who and when come together: a confirmation without its author is no confirmation.
    check(
      "protected_objects_status_confirmed_ck",
      sql`(${t.statusConfirmedAt} IS NULL) = (${t.statusConfirmedBy} IS NULL)`,
    ),
    // A person's objects (the explorer's people, #49) and the ON DELETE SET NULL of `users`.
    index("protected_objects_tenant_user_idx").on(t.tenantId, t.userId),
  ],
);

/** Why an orphaned object is still in the directory but not backed up (`status_reason`). */
export const OBJECT_STATUS_REASONS = ["account_disabled", "no_license", "locked"] as const;
export type ObjectStatusReason = (typeof OBJECT_STATUS_REASONS)[number];

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type ProtectedObject = typeof protectedObjects.$inferSelect;
export type NewProtectedObject = typeof protectedObjects.$inferInsert;
export type SourceStatus = (typeof sourceStatusEnum.enumValues)[number];
export type ImapSecurity = (typeof imapSecurityEnum.enumValues)[number];
export type CredentialStatus = (typeof credentialStatusEnum.enumValues)[number];
