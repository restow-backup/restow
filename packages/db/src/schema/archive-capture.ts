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
import { createdOnly, type FailureRecordJson, timestamps } from "./_shared.js";
import { user } from "./auth.js";
import { protectedObjects, sources } from "./sources.js";
import { tenants } from "./tenants.js";

/**
 * Continuous archive capture from the mailbox (docs/ARCHIVE.md "Erfassungswege", 0.4.4):
 * the worker's capture service (apps/worker/src/archive-capture) keeps one stream per
 * archived mailbox and way. Streams are the service's queue: due rows are claimed with
 * `FOR UPDATE SKIP LOCKED` and a lease, so several worker processes never work one
 * mailbox at the same time and a crashed one only delays it. No `jobs` row per event.
 */

/** The ways a stream captures from the mailbox itself (SMTP ways need no stream). */
export const archiveCaptureWayEnum = pgEnum("archive_capture_way", ["graph_sync", "imap_sync"]);

/**
 * `pending`: wanted by a job, nothing done yet; `backfilling`: live capture is set up and the
 * one-time takeover of the existing mail runs; `live`: capturing; `paused`: kept but not
 * worked (an administrator, or a source that is disabled); `disabled`: no job wants it any
 * more (kept for its state and history); `error`: failed repeatedly, retried with backoff.
 */
export const archiveStreamStatusEnum = pgEnum("archive_stream_status", [
  "pending",
  "backfilling",
  "live",
  "paused",
  "disabled",
  "error",
]);

/** Graph change notification subscription state (Microsoft Graph lifecycle notifications). */
export const graphSubscriptionStatusEnum = pgEnum("graph_subscription_status", [
  "active",
  "reauthorization_required",
  "removed",
  "failed",
]);

/**
 * What a way remembers between two passes, owned by the way's own code (workstreams B and
 * C): Graph `{ deltaLinks, folders }`, IMAP `{ folders: { <path>: { uidValidity, lastUid,
 * highestModseq? } }, idle }`. Readers must tolerate keys they do not know.
 */
export type ArchiveStreamState = Record<string, unknown>;

/** One mailbox captured one way. */
export const archiveCaptureStreams = pgTable(
  "archive_capture_streams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    way: archiveCaptureWayEnum("way").notNull(),
    status: archiveStreamStatusEnum("status").notNull().default("pending"),
    // When live capture started: mail received before it and captured by the backfill is
    // flagged `captured-late`.
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    // The `jobs` row of the one-time backfill ("Archiv-Übernahme"), while or after it ran.
    backfillJobId: uuid("backfill_job_id"),
    backfillCompletedAt: timestamp("backfill_completed_at", { withTimezone: true }),
    state: jsonb("state").$type<ArchiveStreamState>().notNull().default({}),
    // A notification or a resync asked for a pass; cleared when a pass started after it ends.
    dirtySince: timestamp("dirty_since", { withTimezone: true }),
    // When the service passes next; null = nothing to do (paused, or disabled and released).
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    // The worker process working the stream right now, and until when its claim holds.
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastCaptureAt: timestamp("last_capture_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    failure: jsonb("failure").$type<FailureRecordJson>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("archive_capture_streams_object_way_uq").on(t.protectedObjectId, t.way),
    index("archive_capture_streams_due_idx").on(t.nextDueAt).where(sql`${t.nextDueAt} IS NOT NULL`),
    index("archive_capture_streams_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

/**
 * Mail a notification announced and the stream has not fetched yet (Graph change
 * notifications). Written by the API's notification hook, drained by the stream's next
 * pass; one row per mail, however often it is announced.
 */
export const archiveCapturePending = pgTable(
  "archive_capture_pending",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    way: archiveCaptureWayEnum("way").notNull(),
    externalRef: text("external_ref").notNull(),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex("archive_capture_pending_object_way_ref_uq").on(
      t.protectedObjectId,
      t.way,
      t.externalRef,
    ),
    index("archive_capture_pending_tenant_idx").on(t.tenantId),
  ],
);

/** A Microsoft Graph change notification subscription of one archived mailbox. */
export const graphSubscriptions = pgTable(
  "graph_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    // Graph's id of the subscription; the hook finds the stream by it.
    subscriptionId: text("subscription_id").notNull(),
    resource: text("resource").notNull(),
    // SHA-256 (hex) of the clientState sent to Graph; the secret itself is never stored.
    clientStateHash: text("client_state_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: graphSubscriptionStatusEnum("status").notNull().default("active"),
    lastNotificationAt: timestamp("last_notification_at", { withTimezone: true }),
    lastLifecycleEvent: text("last_lifecycle_event"),
    failure: jsonb("failure").$type<FailureRecordJson>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("graph_subscriptions_subscription_uq").on(t.subscriptionId),
    index("graph_subscriptions_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'active'`),
    uniqueIndex("graph_subscriptions_object_active_uq")
      .on(t.protectedObjectId)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * The archive address of one IMAP account (`archive+<token>@<journal host>`): a provider
 * forwards a copy of every mail of the account to it (BCC map, Sieve `redirect :copy`), and
 * the receiver assigns the copy to exactly this account. Rotating inserts a new row and
 * revokes the old one; at most one active address per account.
 */
export const archiveForwardAddresses = pgTable(
  "archive_forward_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    protectedObjectId: uuid("protected_object_id")
      .notNull()
      .references(() => protectedObjects.id, { onDelete: "cascade" }),
    // 160-bit lowercase base32; resolved on every RCPT TO.
    token: text("token").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex("archive_forward_addresses_token_uq").on(t.token),
    uniqueIndex("archive_forward_addresses_object_active_uq")
      .on(t.protectedObjectId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("archive_forward_addresses_tenant_idx").on(t.tenantId),
  ],
);

export type ArchiveCaptureStream = typeof archiveCaptureStreams.$inferSelect;
export type NewArchiveCaptureStream = typeof archiveCaptureStreams.$inferInsert;
export type ArchiveCaptureWay = (typeof archiveCaptureWayEnum.enumValues)[number];
export type ArchiveStreamStatus = (typeof archiveStreamStatusEnum.enumValues)[number];
export type ArchiveCapturePendingRow = typeof archiveCapturePending.$inferSelect;
export type GraphSubscription = typeof graphSubscriptions.$inferSelect;
export type NewGraphSubscription = typeof graphSubscriptions.$inferInsert;
export type GraphSubscriptionStatus = (typeof graphSubscriptionStatusEnum.enumValues)[number];
export type ArchiveForwardAddress = typeof archiveForwardAddresses.$inferSelect;
export type NewArchiveForwardAddress = typeof archiveForwardAddresses.$inferInsert;
