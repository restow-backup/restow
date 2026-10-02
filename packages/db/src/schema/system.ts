import { sql } from "drizzle-orm";
import {
  boolean,
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
import { timestamps } from "./_shared.js";

/** Editions of the installed license (data model only: the license module
 *  under ee/licensing reads and writes it; the core apps never do). */
export const editionEnum = pgEnum("edition", ["community", "business", "service_provider"]);

/** Operating mode chosen in the setup wizard. */
export const operatingModeEnum = pgEnum("operating_mode", ["local", "public"]);

/** Notification mail transport. */
export const mailTransportEnum = pgEnum("mail_transport", ["smtp", "graph"]);

/** Release channel of the update check: `beta` also offers pre-releases. */
export const updateChannelEnum = pgEnum("update_channel", ["stable", "beta"]);

/**
 * The installed license (data model only). Kept in the one schema of the
 * installation so that installing or removing a key never needs a migration
 * and both builds share one migration set; the license module under
 * ee/licensing and ee/api is the only code that reads or writes it. Only the
 * verified terms of a key are stored, never a secret.
 */
export const license = pgTable("license", {
  id: uuid("id").primaryKey().defaultRandom(),
  edition: editionEnum("edition").notNull().default("community"),
  // Unused: there is no mailbox limit, and nothing reads or writes this column any
  // more. It stays so that the migrations already shipped keep matching the schema.
  mailboxLimit: integer("mailbox_limit"),
  multiTenant: boolean("multi_tenant").notNull().default(false),
  licensee: text("licensee"),
  installationId: text("installation_id").notNull(),
  // Ed25519 signature of the license key, verified before the row was written.
  signature: text("signature"),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  // The currently applied license row.
  active: boolean("active").notNull().default(true),
  ...timestamps(),
});

export type MailConfig =
  | {
      transport: "smtp";
      host: string;
      port: number;
      security: "starttls" | "implicit" | "none";
      from: string;
      username?: string;
    }
  | {
      transport: "graph";
      // Sender mailbox in the tenant (Graph sendMail as app).
      sender: string;
      // Entra tenant of the sender mailbox; falls back to GRAPH_MAIL_TENANT_ID when absent.
      tenantId?: string;
    };

/** One release as the update check keeps it (docs/ARCHITECTURE.md, Updates). */
export type StoredUpdateRelease = {
  /** `1.2.3` or `1.2.3-rc.1`, without the `v`. */
  version: string;
  /** The tag as published. */
  tag: string;
  name: string | null;
  publishedAt: string | null;
  url: string | null;
  prerelease: boolean;
  /** Release notes as Markdown source, cut to a fixed length. */
  notes: string | null;
  notesTruncated: boolean;
  /** Image digests the release published for its images. */
  digests: { app?: string; web?: string };
};

/**
 * The cached result of the last update check. A failed check keeps the
 * releases of the last good one (`lastOkAt` says when that was) and adds the
 * reason. `source` and `channel` record what was checked, so a change of
 * either invalidates the cache.
 */
export type StoredUpdateCheck = {
  source: string;
  channel: "stable" | "beta";
  state: "ok" | "failed";
  checkedAt: string;
  lastOkAt: string | null;
  releases: StoredUpdateRelease[];
  error: {
    code: string;
    status: number | null;
    retryAt: string | null;
    detail: string | null;
  } | null;
};

/**
 * Single-row installation configuration written by the setup wizard in one
 * transaction together with the first provider admin. `setupCompletedAt` is the
 * one-way lock of the public wizard: once set it is never cleared, whatever
 * happens to accounts or roles later (lost admins are recovered from the command
 * line, never through the wizard). `passkeyReady` reflects the ongoing check that
 * the domain is cleanly connected (HTTPS, valid cert, matching origin) before
 * passkeys are offered; otherwise the emergency password + TOTP path applies.
 * Secrets in `mailConfig` (e.g. SMTP password) are NOT stored here — only in the
 * encrypted secret store. `singleton` is a unique flag keeping this table to one row.
 */
export const settings = pgTable(
  "settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Always true; the unique index keeps exactly one settings row.
    singleton: boolean("singleton").notNull().default(true),
    operatingMode: operatingModeEnum("operating_mode"),
    // Origin only, e.g. https://restow.example.com.
    publicUrl: text("public_url"),
    passkeyReady: boolean("passkey_ready").notNull().default(false),
    mailTransport: mailTransportEnum("mail_transport"),
    mailConfig: jsonb("mail_config").$type<MailConfig>(),
    // The operator marked the notification mail as not needed ("Start" checklist, docs/ARCHITECTURE.md):
    // a configured transport that nobody wants tested no longer keeps the checklist open. An
    // installation without a transport needs no mark; its checklist item counts as not needed already.
    mailNotNeeded: boolean("mail_not_needed").notNull().default(false),
    // When the setup wizard finished; null only on a fresh installation.
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
    // Operator responsibility notice (the first wizard step, shown once to the
    // provider admin of an installation that predates it). Version of the text
    // that was accepted, when, and from which client address. All null until
    // accepted; a newer text version asks again. The IP is null when it is
    // unknown (behind no proxy header) and in demo mode, which stores none.
    disclaimerVersion: text("disclaimer_version"),
    disclaimerAcceptedAt: timestamp("disclaimer_accepted_at", { withTimezone: true }),
    disclaimerAcceptedIp: text("disclaimer_accepted_ip"),
    // Update check (docs/ARCHITECTURE.md, Updates). Off until an administrator
    // turns it on; the daily check only reads the release list of the source.
    // A null `updateSourceUrl` is the default source (the public releases of
    // the project). The access token for a private source is NOT stored here:
    // it lives in the encrypted secret store (kind `update_source_token`).
    updateCheckEnabled: boolean("update_check_enabled").notNull().default(false),
    updateSourceUrl: text("update_source_url"),
    updateChannel: updateChannelEnum("update_channel").notNull().default("stable"),
    // The cached result of the last check; null before the first one.
    updateCheck: jsonb("update_check").$type<StoredUpdateCheck>(),
    // The newest version an "update available" alert was raised for: one alert per version.
    updateNotifiedVersion: text("update_notified_version"),
    // The last updater journal entry written to the audit log (ids sort chronologically).
    updateAuditCursor: text("update_audit_cursor"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("settings_singleton_uq").on(t.singleton)],
);

/** The three process roles of the one Restow image (docs/ARCHITECTURE.md). */
export const serviceRoleEnum = pgEnum("service_role", ["api", "worker", "scheduler"]);

/**
 * What a process reports next to its beat. Free-form beyond the documented
 * keys, and never a secret, a connection string or an IP address.
 */
export type ServiceHeartbeatDetails = {
  // What the process is doing right now: worker `running` or `stopping`, scheduler
  // `leader`, `standby` or `stopping`.
  state?: string;
  // scheduler: whether this instance currently holds the leader lock.
  leader?: boolean;
  // worker: the queues this instance consumes.
  queues?: string[];
  [key: string]: unknown;
};

/** Name of the constraint that keeps IP addresses out of `service_heartbeats.hostname`. */
export const SERVICE_HEARTBEAT_HOSTNAME_CHECK = "service_heartbeats_hostname_not_ip";

/**
 * Liveness of the running api, worker and scheduler processes: each instance
 * upserts its row (by `instance_id`) on a fixed interval and removes it on a
 * graceful shutdown, so `/readyz` and the system health view can tell a
 * stalled queue from an absent worker. Installation-level, no tenant data and
 * therefore no Row Level Security; both application roles read and write it.
 *
 * `hostname` identifies the machine or container for the operator. It is never
 * an IP address: the check constraint refuses IPv4 and IPv6 literals, so a
 * writer stores null when the host has no name.
 */
export const serviceHeartbeats = pgTable(
  "service_heartbeats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: serviceRoleEnum("role").notNull(),
    // Stable for the lifetime of one process (random per start).
    instanceId: text("instance_id").notNull(),
    // The Restow version the process runs (package version or image tag).
    version: text("version").notNull(),
    hostname: text("hostname"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    beatAt: timestamp("beat_at", { withTimezone: true }).notNull().defaultNow(),
    details: jsonb("details").$type<ServiceHeartbeatDetails>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("service_heartbeats_instance_uq").on(t.instanceId),
    index("service_heartbeats_role_beat_idx").on(t.role, t.beatAt),
    // No dotted IPv4 literal, and no colon: every IPv6 literal has one, no host name does.
    check(
      SERVICE_HEARTBEAT_HOSTNAME_CHECK,
      sql`${t.hostname} !~ '^[0-9]{1,3}([.][0-9]{1,3}){3}$' AND strpos(${t.hostname}, ':') = 0`,
    ),
  ],
);

export type License = typeof license.$inferSelect;
export type NewLicense = typeof license.$inferInsert;
export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
export type Edition = (typeof editionEnum.enumValues)[number];
export type ServiceHeartbeat = typeof serviceHeartbeats.$inferSelect;
export type NewServiceHeartbeat = typeof serviceHeartbeats.$inferInsert;
export type ServiceRole = (typeof serviceRoleEnum.enumValues)[number];
