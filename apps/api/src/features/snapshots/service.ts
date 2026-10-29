import { expandSeries, type RecurringEventLike } from "@restow/core";
import {
  chunkIdsFromDriver,
  type Database,
  type ManifestObjectKind,
  manifestEntries,
  type ProtectedObject,
  protectedObjects,
  type Source,
  snapshots,
  sources,
  users,
} from "@restow/db";
import { and, desc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { type AuditEvent, audit } from "../../lib/audit.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { ObjectState } from "../verify/summary.js";
import {
  loadObjectVerifications,
  loadSnapshotVerifications,
  type SnapshotVerificationDto,
  unverifiedSnapshot,
} from "../verify/verification-state.js";
import {
  canAccessObject,
  isOwnObject,
  normalizeEmail,
  type OwnedObject,
  onBehalfOfOwner,
  type Viewer,
  visibleObjectsCondition,
} from "./access.js";
import {
  ContentUnavailableError,
  openManifestObjectReader,
  type ReadableManifestEntry,
  readManifestObjectBytes,
} from "./content.js";
import {
  downloadContentType,
  type FoundAttachment,
  type MailPreviewDto,
  PREVIEW_SIZE_CAP_BYTES,
  unavailablePreview,
} from "./preview.js";
import {
  findAttachmentInWorker,
  PreviewBusyError,
  PreviewUnreadableError,
  previewInWorker,
} from "./preview-isolated.js";
import type {
  CalendarQuery,
  ListObjectsQuery,
  ListSnapshotsQuery,
  PeopleQuery,
  SearchQuery,
  TreeQuery,
  VersionsQuery,
} from "./schemas.js";
import {
  ATTACHMENT_PARENT_KEY,
  ATTACHMENTS_FOLDER_KIND,
  type BreadcrumbSegment,
  baseNameOf,
  breadcrumbOf,
  collapseVersions,
  compareEntries,
  type EntryRow,
  escapeLike,
  eventSummaryOf,
  FOLDER_KIND_KEY,
  fingerprintOf,
  mailSummaryOf,
  NATIVE_VERSION_MARKER,
  nativeVersionsParent,
  type StoredVersionDto,
  type TreeEntryDto,
  toStoredVersion,
  toTreeEntry,
  type VersionDto,
  type VersionRow,
} from "./tree.js";

/**
 * Snapshot browsing for the restore explorer (docs/ARCHITECTURE.md, restore and
 * file explorer section). Everything reads the Postgres index of the manifests
 * through `manifestEntries` (@restow/db manifest-versions.ts: version rows,
 * plus the 0.3.4 per-snapshot rows not converted yet), which yields exactly
 * the objects of the selected snapshots; the manifest in storage stays the
 * truth for the standalone restore. Every query runs in a tenant-pinned transaction (RLS)
 * and is additionally filtered to the viewer's own objects for end users.
 *
 * Reading backup contents (a folder listing, a version history, a search) is
 * audited like every other read of data: who, from where, what, and whose data
 * when it is not the reader's own.
 */

/** Audit actions written by this feature. */
export const SNAPSHOT_AUDIT_ACTIONS = {
  treeRead: "snapshot.tree.read",
  versionsRead: "snapshot.versions.read",
  searched: "snapshot.searched",
  mailPreviewed: "snapshot.mail.previewed",
  attachmentDownloaded: "snapshot.mail.attachment_downloaded",
  calendarRead: "snapshot.calendar.read",
} as const;

/** A viewer reading backup contents, with the client IP the audit log records. */
export interface SnapshotReader extends Viewer {
  ip: string | null;
}

type ReadEvent = Required<
  Pick<AuditEvent, "action" | "target" | "targetType" | "onBehalfOf" | "details">
>;

/**
 * Record a read of backup contents. Called as the last statement of the read's
 * transaction: the entry commits with the read (a failed write fails the read),
 * and the tenant's audit-chain lock is held only until the commit.
 */
async function auditRead(
  tx: DbExecutor,
  tenantId: string,
  reader: SnapshotReader,
  event: ReadEvent,
): Promise<void> {
  await audit(tx, {
    tenantId,
    actor: reader.email,
    actorUserId: reader.userId,
    ip: reader.ip,
    ...event,
  });
}

/** Identifies the protected object a read touched, for the audit details. */
function objectDetails(object: ProtectedObject): Record<string, unknown> {
  return {
    protectedObjectId: object.id,
    objectKind: object.kind,
    externalId: object.externalId,
  };
}

function ownedObject(object: ProtectedObject, ownerEmail: string | null): OwnedObject {
  return { externalId: object.externalId, ownerEmail };
}

export interface SnapshotObjectDto {
  id: string;
  kind: ProtectedObject["kind"];
  externalId: string;
  displayName: string | null;
  status: ProtectedObject["status"];
  /**
   * Why an orphaned mailbox is not backed up although its account still exists (disabled, no
   * licence); null for every other object and for one removed from the source.
   */
  statusReason: ProtectedObject["statusReason"];
  /** m365 or imap: which source backs this object up, for the explorer's grouping. */
  sourceKind: Source["kind"];
  ownerEmail: string | null;
  /**
   * The person the object belongs to (the directory user, `protected_objects.user_id`), so the
   * explorer can show a person's mailbox, OneDrive and IMAP account as one entry (#49); null for
   * an object of no one (a SharePoint site) or whose user is gone from the directory table.
   */
  ownerKey: string | null;
  /** That person's display name from the directory; null when unknown. */
  ownerName: string | null;
  /** True when the object belongs to the viewer (self-service restore). */
  own: boolean;
  /** Completed backups ("restore points"); 0 for an object never backed up yet. */
  snapshotCount: number;
  latestSnapshotId: string | null;
  /** When the newest restore point completed; null before the first backup. */
  latestSnapshotAt: string | null;
  /** Whether the newest backup (if any) is proven restorable (docs/TESTING.md). */
  readiness: ObjectState;
}

export interface SnapshotDto {
  id: string;
  objectId: string;
  sequence: number;
  itemCount: number;
  byteSize: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** A point in time in the snapshot list, with the verification of exactly that backup. */
export interface ListedSnapshotDto extends SnapshotDto {
  /** `unverified` until a restore check read this snapshot back (verify/verification-state.ts). */
  verification: SnapshotVerificationDto;
}

export interface TreeDto {
  snapshot: SnapshotDto;
  object: Pick<SnapshotObjectDto, "id" | "kind" | "externalId" | "displayName" | "own">;
  folder: { path: string; name: string };
  breadcrumb: BreadcrumbSegment[];
  entries: TreeEntryDto[];
  total: number;
  offset: number;
  hasMore: boolean;
}

export interface VersionsDto {
  objectId: string;
  path: string;
  /** The item across snapshots, newest first, identical content collapsed. */
  versions: VersionDto[];
  /** Earlier versions the source kept, as captured in the requested snapshot. */
  stored: StoredVersionDto[];
}

export interface SearchHitDto extends TreeEntryDto {
  snapshotId: string;
  objectId: string;
}

export interface SearchDto {
  query: string;
  hits: SearchHitDto[];
  /** Snapshots that were searched (one per object unless a snapshot was named). */
  searchedSnapshots: number;
  truncated: boolean;
}

/** A completed snapshot together with its protected object, as loaded for access checks. */
export interface SnapshotWithObject {
  snapshot: typeof snapshots.$inferSelect;
  object: ProtectedObject;
  ownerEmail: string | null;
}

const completedSnapshot = (): SQL =>
  and(eq(snapshots.status, "active"), isNotNull(snapshots.manifestPath)) as SQL;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Raw `execute()` rows carry timestamps as Postgres text (drizzle keeps the driver value). */
function toDate(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toSnapshotDto(row: typeof snapshots.$inferSelect): SnapshotDto {
  return {
    id: row.id,
    objectId: row.protectedObjectId,
    sequence: row.sequence,
    itemCount: row.itemCount,
    byteSize: row.byteSize,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Load a completed snapshot with its object; 404 when unknown, not yet
 * committed, or outside what the viewer may see (a non-owner learns nothing).
 */
export async function loadSnapshotForViewer(
  tx: DbExecutor,
  tenantId: string,
  viewer: Viewer,
  snapshotId: string,
): Promise<SnapshotWithObject> {
  const [row] = await tx
    .select({ snapshot: snapshots, object: protectedObjects, ownerEmail: users.email })
    .from(snapshots)
    .innerJoin(protectedObjects, eq(protectedObjects.id, snapshots.protectedObjectId))
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    .where(and(eq(snapshots.tenantId, tenantId), eq(snapshots.id, snapshotId), completedSnapshot()))
    .limit(1);
  if (
    !row ||
    !canAccessObject(viewer, { externalId: row.object.externalId, ownerEmail: row.ownerEmail })
  ) {
    throw new ProblemError(404, "Snapshot not found");
  }
  return row;
}

/** Load a protected object the viewer may browse; 404 otherwise. */
export async function loadObjectForViewer(
  tx: DbExecutor,
  tenantId: string,
  viewer: Viewer,
  objectId: string,
): Promise<{ object: ProtectedObject; ownerEmail: string | null }> {
  const [row] = await tx
    .select({ object: protectedObjects, ownerEmail: users.email })
    .from(protectedObjects)
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, objectId)))
    .limit(1);
  if (
    !row ||
    !canAccessObject(viewer, { externalId: row.object.externalId, ownerEmail: row.ownerEmail })
  ) {
    throw new ProblemError(404, "Protected object not found");
  }
  return row;
}

// ---------------------------------------------------------------------------
// Objects and snapshots
// ---------------------------------------------------------------------------

/**
 * Protected objects of the tenant, for the explorer's left pane: with a
 * completed backup by default, or every visible object (`include: "all"`,
 * `snapshotCount: 0`, `latestSnapshotAt: null`) so a mailbox, OneDrive or
 * IMAP account that has never been backed up still shows, by its display
 * name and address, never a bare id.
 */
export async function listObjects(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  query: Pick<ListObjectsQuery, "include"> = { include: "withBackup" },
): Promise<SnapshotObjectDto[]> {
  return withTenantTx(db, tenantId, (tx) => selectObjects(tx, tenantId, viewer, query.include));
}

/** The snapshot objects of {@link listObjects}, optionally only those with the given ids. */
async function selectObjects(
  tx: DbExecutor,
  tenantId: string,
  viewer: Viewer,
  include: ListObjectsQuery["include"],
  ids?: readonly string[],
): Promise<SnapshotObjectDto[]> {
  if (ids && ids.length === 0) {
    return [];
  }
  const visible = visibleObjectsCondition(viewer);
  const snapshotJoin = and(
    eq(snapshots.protectedObjectId, protectedObjects.id),
    completedSnapshot(),
  ) as SQL;
  const rows = await tx
    .select({
      id: protectedObjects.id,
      kind: protectedObjects.kind,
      externalId: protectedObjects.externalId,
      displayName: protectedObjects.displayName,
      status: protectedObjects.status,
      statusReason: protectedObjects.statusReason,
      sourceKind: sources.kind,
      ownerEmail: users.email,
      ownerKey: protectedObjects.userId,
      ownerName: users.displayName,
      snapshotCount: sql<number>`count(${snapshots.id})::int`,
      latestSnapshotId: sql<
        string | null
      >`(array_agg(${snapshots.id} order by ${snapshots.sequence} desc))[1]`,
      latestSnapshotAt: sql<Date | null>`max(${snapshots.completedAt})`.mapWith(
        snapshots.completedAt,
      ),
    })
    .from(protectedObjects)
    .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    // Always a LEFT JOIN: with `include: "all"` an object with no completed
    // snapshot still gets a (null) row to aggregate into zeros; otherwise
    // the same rows are dropped below, which is exactly an inner join.
    .leftJoin(snapshots, snapshotJoin)
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        ...(visible ? [visible] : []),
        ...(include === "all" ? [] : [isNotNull(snapshots.id)]),
        ...(ids ? [inArray(protectedObjects.id, [...ids])] : []),
      ),
    )
    .groupBy(protectedObjects.id, sources.kind, users.email, users.displayName)
    .orderBy(sql`lower(coalesce(${protectedObjects.displayName}, ${protectedObjects.externalId}))`);

  const verifications = await loadObjectVerifications(
    tx,
    tenantId,
    rows.map((row) => row.id),
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    externalId: row.externalId,
    displayName: row.displayName,
    status: row.status,
    statusReason: row.status === "orphaned" ? row.statusReason : null,
    sourceKind: row.sourceKind,
    ownerEmail: row.ownerEmail,
    // Sites and group mailboxes belong to no person.
    ownerKey: row.kind === "site" || row.kind === "group" ? null : row.ownerKey,
    ownerName: row.kind === "site" || row.kind === "group" ? null : row.ownerName,
    own: isOwnObject(viewer, row),
    snapshotCount: Number(row.snapshotCount),
    latestSnapshotId: row.latestSnapshotId,
    latestSnapshotAt: iso(row.latestSnapshotAt),
    readiness: verifications.get(row.id)?.verification.state ?? "no_backup",
  }));
}

/** Completed snapshots (points in time), newest first, each with its verification. */
export async function listSnapshots(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  query: ListSnapshotsQuery,
): Promise<ListedSnapshotDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    if (query.objectId) {
      await loadObjectForViewer(tx, tenantId, viewer, query.objectId);
    }
    const visible = visibleObjectsCondition(viewer);
    const rows = await tx
      .select({ snapshot: snapshots })
      .from(snapshots)
      .innerJoin(protectedObjects, eq(protectedObjects.id, snapshots.protectedObjectId))
      .leftJoin(users, eq(users.id, protectedObjects.userId))
      .where(
        and(
          eq(snapshots.tenantId, tenantId),
          completedSnapshot(),
          ...(query.objectId ? [eq(snapshots.protectedObjectId, query.objectId)] : []),
          ...(visible ? [visible] : []),
        ),
      )
      .orderBy(desc(snapshots.sequence))
      .limit(query.limit);
    const verifications = await loadSnapshotVerifications(
      tx,
      tenantId,
      rows.map((row) => ({ id: row.snapshot.id, objectId: row.snapshot.protectedObjectId })),
    );
    return rows.map((row) => ({
      ...toSnapshotDto(row.snapshot),
      verification: verifications.get(row.snapshot.id) ?? unverifiedSnapshot(),
    }));
  });
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface ListingScope {
  tenantId: string;
  snapshotId: string;
  /** The snapshot's object and sequence: its entries are the version rows whose range holds it. */
  objectId: string;
  sequence: number;
  path: string;
  includeDeleted: boolean;
  foldersOnly: boolean;
  /** Hide OneDrive's `<file>:versions/<id>` objects (they belong to the version panel). */
  hideNativeVersions: boolean;
  /**
   * `date` (default): mail and events newest first, folders first. `upcoming`: events still
   * ahead first, soonest first, then as `date`. `name`: everything by name, folders first.
   */
  sort: "date" | "upcoming" | "name";
}

/** The raw shape of a listing row (see {@link legacyListingCte} and {@link versionListingCte}). */
interface ListingRow extends Record<string, unknown> {
  id: string;
  kind: ManifestObjectKind;
  name: string;
  path: string;
  parent_path: string;
  size: string | number;
  mtime: string | null;
  item_id: string | null;
  deleted: boolean;
  metadata: Record<string, unknown> | null;
  implicit: boolean;
}

/**
 * The priority order {@link mailSummaryOf} (tree.ts) uses for a mail's own
 * `date` field, mirrored here so the tree's default SQL sort agrees with the
 * in-memory `compareEntries` used to sort search hits (which sorts by
 * `mail.date`, the same field).
 */
const MAIL_DATE_METADATA_KEYS = [
  "receivedDateTime",
  "receivedAt",
  "internalDate",
  "sentDateTime",
  "date",
] as const;

/**
 * The date a mail entry sorts (and is shown) by: the first of its metadata's
 * own recorded dates ({@link MAIL_DATE_METADATA_KEYS}), cast to `timestamptz`
 * only when it both looks like an ISO-8601 timestamp and is one Postgres can
 * actually represent (`pg_input_is_valid`; a structurally ISO-8601 but
 * out-of-range value, e.g. a `2026-02-30`, still fails the plain `::timestamptz`
 * cast with an error and must not error the whole folder listing), else
 * `mtime`.
 *
 * `mtime` alone is the wrong default for Exchange mail: `manifest_versions.mtime`
 * is the source's `lastModifiedDateTime` (packages/core/src/backup/exchange/mail.ts
 * `toMillis(entry.lastModifiedDateTime) || toMillis(entry.receivedDateTime)`),
 * which a read-flag or category change bumps independently of when the
 * message actually arrived, so a year-old mail flagged yesterday would sort
 * to the top.
 *
 * `internalDate` (the mailbox's own arrival time, IMAP's counterpart of
 * Exchange's `receivedDateTime`) ranks ahead of `sentDateTime` (the IMAP
 * envelope's `Date:` header) because the sender controls that header: a
 * forged future `Date:` must not pin a message to the top of the folder.
 * IMAP's `mtime` is already `internalDate`, so for a message that carries no
 * `receivedDateTime`/`receivedAt`, this coalesce reaches the same value
 * either way, spoofed `Date:` header or not.
 */
function mailDateExpression(metadata: SQL, mtime: SQL): SQL {
  const isoDate = (key: string) => sql`
    CASE WHEN (${metadata} ->> ${key}) ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}'
           AND pg_input_is_valid(${metadata} ->> ${key}, 'timestamptz')
         THEN (${metadata} ->> ${key})::timestamptz END`;
  const candidates = MAIL_DATE_METADATA_KEYS.map((key) => isoDate(key));
  return sql`COALESCE(${sql.join(candidates, sql`, `)}, ${mtime})`;
}

/**
 * When an event starts, from its metadata's `start` (packages/core backup/exchange/calendar.ts
 * `eventMetadata`): Graph's UTC time without a zone suffix, cast only when it looks like one and
 * Postgres can represent it (same reasoning as {@link mailDateExpression}); null otherwise.
 */
function eventStartExpression(metadata: SQL): SQL {
  const start = sql`left(${metadata} ->> 'start', 19)`;
  return sql`
    CASE WHEN ${start} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$'
           AND pg_input_is_valid(${start}, 'timestamp')
         THEN ${start}::timestamp AT TIME ZONE 'UTC' END`;
}

/** The end of an event, like {@link eventStartExpression}. */
function eventEndExpression(metadata: SQL): SQL {
  const end = sql`left(${metadata} ->> 'end', 19)`;
  return sql`
    CASE WHEN ${end} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$'
           AND pg_input_is_valid(${end}, 'timestamp')
         THEN ${end}::timestamp AT TIME ZONE 'UTC' END`;
}

/** The entries of the given snapshots (see `manifestEntries`), as a FROM item. */
function snapshotEntries(tenantId: string, snapshotIds: readonly string[], chunks = false): SQL {
  const ids = sql.join(
    snapshotIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return manifestEntries({ tenantId, snapshots: sql`s.id IN (${ids})`, chunks });
}

/** An entry as a raw `manifestEntries` row carries it. */
interface RawEntryRow extends Record<string, unknown> {
  id: string;
  snapshot_id: string;
  snapshot_sequence: number;
  snapshot_completed_at: Date | string | null;
  protected_object_id: string;
  kind: ManifestObjectKind;
  name: string;
  path: string;
  parent_path: string;
  size: string | number;
  mtime: Date | string | null;
  item_id: string | null;
  message_id: string | null;
  metadata: Record<string, unknown> | null;
  deleted: boolean;
  chunk_refs?: unknown;
}

function fromRawEntry(row: RawEntryRow): EntryRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    parentPath: row.parent_path,
    size: Number(row.size),
    mtime: toDate(row.mtime),
    itemId: row.item_id,
    deleted: row.deleted,
    metadata: row.metadata,
  };
}

function chunkRefsOf(row: RawEntryRow): string[] | null {
  return row.chunk_refs === null || row.chunk_refs === undefined
    ? null
    : chunkIdsFromDriver(row.chunk_refs);
}

/**
 * The children of one folder as a `listing` CTE: the rows whose parent is the
 * folder, plus one synthetic folder for every child segment that only exists
 * as a parent of deeper rows. Backups do not record every folder (area roots
 * like `mail` or `calendar` have no row of their own), and without these the
 * explorer could not reach anything below them. Attachments of JSON-format
 * messages and OneDrive's own version objects are not browsed.
 *
 * This form reads every entry of the snapshot, and is used only for a snapshot
 * of 0.3.4 or earlier whose per-snapshot rows the worker has not converted yet
 * (`manifest_objects`); every other snapshot is listed by
 * {@link versionListingCte}, which returns the same rows from an index.
 */
function legacyListingCte(scope: ListingScope): SQL {
  const path = sql`${scope.path}::text`;
  const filters: SQL[] = [
    sql`(m.metadata ->> ${ATTACHMENT_PARENT_KEY}::text) IS NULL`,
    notAttachmentsFolder("m"),
  ];
  if (!scope.includeDeleted) {
    filters.push(sql`m.deleted = false`);
  }
  if (scope.hideNativeVersions) {
    filters.push(sql`strpos(m.path, ${NATIVE_VERSION_MARKER}::text) = 0`);
  }
  const childPath = sql`CASE WHEN ${path} = '' THEN n.segment ELSE ${path} || '/' || n.segment END`;
  return sql`
    WITH scope AS (
      SELECT m.id, m.kind, m.name, m.path, m.parent_path, m.size, m.mtime, m.item_id, m.deleted, m.metadata
      FROM ${snapshotEntries(scope.tenantId, [scope.snapshotId])} AS m
      WHERE ${sql.join(filters, sql` AND `)}
    ),
    direct AS (
      SELECT s.id::text AS id, s.kind, s.name, s.path, s.parent_path, s.size, s.mtime,
             s.item_id, s.deleted, s.metadata,
             CASE WHEN s.kind = 'mail' THEN ${mailDateExpression(sql`s.metadata`, sql`s.mtime`)}
                  WHEN s.kind = 'event' THEN ${eventStartExpression(sql`s.metadata`)}
             END AS sort_date,
             false AS implicit
      FROM scope s
      WHERE s.parent_path = ${path}
        ${scope.foldersOnly ? sql`AND s.kind = 'folder'` : sql``}
    ),
    nested AS (
      SELECT split_part(
               CASE WHEN ${path} = '' THEN s.parent_path
                    ELSE substr(s.parent_path, length(${path}) + 2) END,
               '/', 1) AS segment,
             s.deleted
      FROM scope s
      WHERE CASE WHEN ${path} = '' THEN s.parent_path <> ''
                 ELSE left(s.parent_path, length(${path}) + 1) = ${path} || '/' END
    ),
    implicit AS (
      SELECT 'folder:' || ${childPath} AS id, 'folder'::manifest_object_kind AS kind,
             n.segment AS name, ${childPath} AS path, ${path} AS parent_path,
             0::bigint AS size, NULL::timestamptz AS mtime, NULL::text AS item_id,
             bool_and(n.deleted) AS deleted, NULL::jsonb AS metadata,
             NULL::timestamptz AS sort_date, true AS implicit
      FROM nested n
      WHERE n.segment <> ''
        AND NOT EXISTS (
          SELECT 1 FROM scope x WHERE x.parent_path = ${path} AND x.name = n.segment
        )
      GROUP BY n.segment
    ),
    listing AS (
      SELECT * FROM direct
      UNION ALL
      SELECT * FROM implicit
    )
  `;
}

/** Not the attachments folder of a JSON-format message (see {@link ATTACHMENTS_FOLDER_KIND}). */
function notAttachmentsFolder(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.kind <> 'folder' OR (${a}.metadata ->> ${FOLDER_KIND_KEY}::text) IS DISTINCT FROM ${ATTACHMENTS_FOLDER_KIND}::text)`;
}

/**
 * Conditions that make a `manifest_versions` row (as `alias`) an entry of the
 * scope's snapshot that the listing shows: its range holds the snapshot's
 * sequence, and it is not an attachment of a JSON-format message, not deleted
 * (unless asked for) and not one of OneDrive's own versions (for drives and
 * sites). The same filters as {@link legacyListingCte}'s `scope`.
 */
function listedVersion(
  scope: ListingScope,
  alias: string,
  options: { attachmentsFolders?: boolean } = {},
): SQL {
  const v = sql.raw(alias);
  const filters: SQL[] = [
    sql`${v}.protected_object_id = ${scope.objectId}::uuid`,
    sql`${v}.tenant_id = ${scope.tenantId}::uuid`,
    sql`${v}.first_sequence <= ${scope.sequence}::int`,
    sql`${v}.last_sequence >= ${scope.sequence}::int`,
    sql`(${v}.metadata ->> ${ATTACHMENT_PARENT_KEY}::text) IS NULL`,
  ];
  if (!options.attachmentsFolders) {
    filters.push(notAttachmentsFolder(alias));
  }
  if (!scope.includeDeleted) {
    filters.push(sql`${v}.deleted = false`);
  }
  if (scope.hideNativeVersions) {
    filters.push(sql`strpos(${v}.path, ${NATIVE_VERSION_MARKER}::text) = 0`);
  }
  return sql.join(filters, sql` AND `);
}

/** `parent_path` in byte order, the expression `manifest_versions_object_parent_idx` holds. */
function bytewiseParent(alias: string): SQL {
  return sql`(${sql.raw(alias)}.parent_path COLLATE "C")`;
}

/**
 * The same `listing` as {@link legacyListingCte}, for a snapshot whose entries
 * are version rows (every snapshot from 0.3.5 on), read through
 * `manifest_versions_object_parent_idx` (object, parent path in byte order,
 * last sequence) instead of every entry of the snapshot:
 *
 * - `direct`: the rows whose parent is the folder, one index range (the
 *   folders among them from `manifest_versions_object_folder_idx`).
 * - `walk`: a skip scan over the parent paths below the folder. In byte order
 *   everything below `a/b` lies in ['a/b/', 'a/b0'), and everything below its
 *   child `a/b/c` in ['a/b/c/', 'a/b/c0'); after a parent path inside a child's
 *   subtree the walk jumps past that subtree, so it reads one index entry per
 *   child folder (twice for a child whose name continues with a character
 *   sorting before `/`), not one per row below the folder.
 * - `implicit`: of those child segments, the ones without a row of their own
 *   that have an entry of the snapshot below them (an index probe each), with
 *   `deleted` set when every such entry is deleted.
 *
 * Up to 0.4.3 the listing read every entry of the snapshot (every message of
 * a mailbox, every file of a OneDrive) with its metadata, twice per request,
 * and matched the child segments against them without an index: seconds for
 * a large mailbox, minutes for a OneDrive with tens of thousands of folders.
 * Columns as {@link legacyListingCte}, plus `vid` (the row id, null for an
 * implicit folder) and without `metadata`, which {@link queryListing} reads
 * for the rows of the requested page only.
 */
function versionListingCte(scope: ListingScope): SQL {
  const parent = scope.path;
  const prefix = parent === "" ? "" : `${parent}/`;
  const prefixLength = prefix.length;
  // Below the folder: ['a/b/', 'a/b0'); below the root: everything but the root itself.
  const below = (alias: string): SQL =>
    parent === ""
      ? sql`${bytewiseParent(alias)} > ''`
      : sql`${bytewiseParent(alias)} > ${prefix}::text AND ${bytewiseParent(alias)} < ${`${parent}0`}::text`;
  const nextParent = (bound: SQL): SQL => sql`
    SELECT n.parent_path FROM manifest_versions n
    WHERE n.protected_object_id = ${scope.objectId}::uuid AND ${below("n")}
      AND ${bytewiseParent("n")} ${bound}
    ORDER BY ${bytewiseParent("n")}
    LIMIT 1`;
  const segmentOf = (column: SQL): SQL =>
    sql`split_part(substr(${column}, ${prefixLength}::int + 1), '/', 1)`;
  const childPath = sql`(${prefix}::text || g.segment)`;
  /** An entry of the snapshot below the child `g.segment`, optionally with `extra`. */
  const entryBelow = (extra: SQL): SQL => sql`(
    EXISTS (
      SELECT 1 FROM manifest_versions d
      WHERE ${bytewiseParent("d")} = ${childPath} AND ${listedVersion(scope, "d")} AND ${extra}
    )
    OR EXISTS (
      SELECT 1 FROM manifest_versions d
      WHERE ${bytewiseParent("d")} >= ${childPath} || '/'
        AND ${bytewiseParent("d")} < ${childPath} || '0'
        AND ${listedVersion(scope, "d")} AND ${extra}
    )
  )`;
  const deleted = scope.includeDeleted
    ? sql`NOT ${entryBelow(sql`d.deleted = false`)}`
    : sql`false`;
  return sql`
    WITH RECURSIVE direct AS (
      SELECT v.id AS vid, v.id::text AS id, v.kind, v.name, v.path, v.parent_path, v.size, v.mtime,
             v.item_id, v.deleted,
             CASE WHEN v.kind = 'mail' THEN ${mailDateExpression(sql`v.metadata`, sql`v.mtime`)}
                  WHEN v.kind = 'event' THEN ${eventStartExpression(sql`v.metadata`)}
             END AS sort_date,
             false AS implicit
      FROM manifest_versions v
      WHERE ${bytewiseParent("v")} = ${parent}::text
        ${scope.foldersOnly ? sql`AND v.kind = 'folder'` : sql``}
        AND ${listedVersion(scope, "v")}
    ),
    walk(pp) AS (
      SELECT (${nextParent(sql`IS NOT NULL`)})
      UNION ALL
      SELECT CASE
               WHEN strpos(substr(w.pp, ${prefixLength}::int + 1), '/') = 0
                 THEN (${nextParent(sql`> w.pp`)})
               ELSE (${nextParent(sql`>= ${prefix}::text || ${segmentOf(sql`w.pp`)} || '0'`)})
             END
      FROM walk w
      WHERE w.pp IS NOT NULL
    ),
    segments AS (
      SELECT DISTINCT ${segmentOf(sql`w.pp`)} AS segment FROM walk w WHERE w.pp IS NOT NULL
    ),
    implicit AS (
      SELECT NULL::uuid AS vid, 'folder:' || ${childPath} AS id, 'folder'::manifest_object_kind AS kind,
             g.segment AS name, ${childPath} AS path, ${parent}::text AS parent_path,
             0::bigint AS size, NULL::timestamptz AS mtime, NULL::text AS item_id,
             ${deleted} AS deleted, NULL::timestamptz AS sort_date, true AS implicit
      FROM segments g
      WHERE g.segment <> ''
        -- A child with a row of its own is listed by direct. In a CASE, so the planner
        -- keeps this an index probe per child instead of an anti-join over every row of
        -- the folder; the probes below run only for the children it leaves. An attachments
        -- folder counts as a row of its own here (direct hides it, and nothing below it is
        -- listed), which spares it those probes.
        AND CASE WHEN EXISTS (
              SELECT 1 FROM manifest_versions x
              WHERE x.path = ${childPath} AND x.parent_path = ${parent}::text AND x.name = g.segment
                AND ${listedVersion(scope, "x", { attachmentsFolders: true })}
            ) THEN false ELSE ${entryBelow(sql`true`)} END
    ),
    listing AS (
      SELECT * FROM direct
      UNION ALL
      SELECT * FROM implicit
    )
  `;
}

/**
 * A sortable key for natural (numeric-aware) name order: every run of digits
 * is zero-padded, so "2.eml" sorts before "10.eml" instead of after (plain
 * text order put "1", "10", "11", "2" in that lexical order, the ordering bug
 * seen in the 0.301.4 demo). Built from a zero-width split between digit and
 * non-digit runs, so it needs no stored function or extension. The pad width
 * is `greatest(length(seg), 20)`, not a bare 20: `lpad` truncates an input
 * longer than its target width, so a digit run past 20 characters (a long
 * numeric identifier in a file name) would otherwise be cut short and could
 * collide with, or sort out of order against, another long run.
 */
function naturalSortKey(column: SQL): SQL {
  return sql`(
    SELECT string_agg(
      CASE WHEN seg ~ '^[0-9]+$' THEN lpad(seg, greatest(length(seg), 20), '0') ELSE lower(seg) END,
      '' ORDER BY ord
    )
    FROM unnest(regexp_split_to_array(${column}, '(?<=\\D)(?=\\d)|(?<=\\d)(?=\\D)'))
      WITH ORDINALITY AS seg_t(seg, ord)
  )`;
}

/**
 * Folders first, always. Within a folder: `sort: "date"` (the default) puts
 * dated mail and events newest first (by `sort_date`, the listing CTE's
 * precomputed {@link mailDateExpression} for mail and {@link eventStartExpression}
 * for an event, not the raw `mtime`), everything else (undated mail, files,
 * contacts) in natural name order; `sort: "upcoming"` puts the events that have
 * not started yet first, soonest first, then the rest as `date` does; `sort:
 * "name"` puts everything in natural name order, mail and events included. See
 * {@link compareEntries} for the equivalent in-memory order used for search hits.
 */
function listingOrder(sort: "date" | "upcoming" | "name"): SQL {
  return sql`ORDER BY ${listingLeadingKeys(sort)}, ${naturalSortKey(sql`name`)}, path`;
}

/**
 * The keys of {@link listingOrder} before the name: cheap to compute, unlike
 * the natural name key, so a page is first cut down by these alone (see
 * {@link listingStatement}).
 */
function listingLeadingKeys(sort: "date" | "upcoming" | "name"): SQL {
  const byDate = sort === "name" ? sql`false` : sql`true`;
  const upcoming = sort === "upcoming" ? sql`kind = 'event' AND sort_date >= now()` : sql`false`;
  return sql`
    CASE WHEN kind = 'folder' THEN 0 ELSE 1 END,
    CASE WHEN ${upcoming} THEN 0 ELSE 1 END,
    CASE WHEN ${upcoming} THEN sort_date END ASC,
    CASE WHEN ${byDate} AND kind IN ('mail', 'event') AND sort_date IS NOT NULL THEN 0 ELSE 1 END,
    CASE WHEN ${byDate} AND kind IN ('mail', 'event') THEN sort_date END DESC
  `;
}

function fromListingRow(row: ListingRow): EntryRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    parentPath: row.parent_path,
    size: Number(row.size),
    mtime: toDate(row.mtime),
    itemId: row.item_id,
    deleted: row.deleted,
    metadata: row.metadata,
    implicit: row.implicit,
  };
}

/** Whether the snapshot still has per-snapshot rows of 0.3.4 or earlier (see `manifestEntries`). */
async function hasLegacyRows(tx: DbExecutor, snapshotId: string): Promise<boolean> {
  const result = await tx.execute<{ legacy: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM manifest_objects WHERE snapshot_id = ${snapshotId}::uuid) AS legacy`,
  );
  return result.rows[0]?.legacy === true;
}

/**
 * The statement of one listing page from the version rows (see
 * {@link versionListingCte}). The listing is computed once (its mail dates
 * included); the rows up to the end of the page are picked by the cheap
 * leading keys of the order, together with every row tied with the last of
 * them (`WITH TIES`), and only those are ordered by name, so a folder of
 * 50 000 messages sorted by date computes the natural name key for a page,
 * not for every message: the same rows in the same order as sorting
 * everything by {@link listingOrder}. The metadata is read afterwards for the
 * rows of the page only, by id; the total comes along with every row.
 */
export function listingStatement(
  scope: ListingScope,
  page: { limit: number; offset: number },
): SQL {
  return sql`
    ${versionListingCte(scope)},
    computed AS MATERIALIZED (SELECT * FROM listing),
    candidates AS (
      SELECT * FROM computed
      ORDER BY ${listingLeadingKeys(scope.sort)}
      FETCH FIRST (${page.offset + page.limit}::bigint) ROWS WITH TIES
    ),
    page AS (
      SELECT * FROM candidates
      ${listingOrder(scope.sort)}
      LIMIT ${page.limit} OFFSET ${page.offset}
    )
    SELECT *, (SELECT count(*) FROM computed) AS total FROM (
      SELECT p.*, v.metadata FROM page p LEFT JOIN manifest_versions v ON v.id = p.vid
    ) AS paged
    ${listingOrder(scope.sort)}
  `;
}

/**
 * One page of a folder's children, with the total for paging. A snapshot of
 * 0.3.4 or earlier not converted yet is listed by a scan of its entries
 * ({@link legacyListingCte}); `method: "scan"` lists any snapshot that way, the
 * reference the tests compare the index-based listing against.
 */
export async function queryListing(
  tx: DbExecutor,
  scope: ListingScope,
  page: { limit: number; offset: number },
  method: "auto" | "scan" = "auto",
): Promise<{ entries: TreeEntryDto[]; total: number }> {
  if (method === "scan" || (await hasLegacyRows(tx, scope.snapshotId))) {
    const listing = legacyListingCte(scope);
    const counted = await tx.execute<{ total: number }>(
      sql`${listing} SELECT count(*)::int AS total FROM listing`,
    );
    const rows = await tx.execute<ListingRow>(
      sql`${listing} SELECT * FROM listing ${listingOrder(scope.sort)} LIMIT ${page.limit} OFFSET ${page.offset}`,
    );
    return {
      entries: rows.rows.map((row) => toTreeEntry(fromListingRow(row))),
      total: Number(counted.rows[0]?.total ?? 0),
    };
  }
  // The planner prices the probe per child folder as if it could read the whole object, which
  // puts the statement past `jit_above_cost`; compiling it then takes longer (about 100 ms)
  // than running it. Local to the caller's transaction.
  await tx.execute(sql`SELECT set_config('jit', 'off', true)`);
  const rows = await tx.execute<ListingRow & { total: number | string }>(
    listingStatement(scope, page),
  );
  let total = Number(rows.rows[0]?.total ?? 0);
  if (rows.rows.length === 0 && page.offset > 0) {
    // A page past the end has no row to carry the count.
    const counted = await tx.execute<{ total: number }>(
      sql`${versionListingCte(scope)} SELECT count(*)::int AS total FROM listing`,
    );
    total = Number(counted.rows[0]?.total ?? 0);
  }
  return { entries: rows.rows.map((row) => toTreeEntry(fromListingRow(row))), total };
}

/** Children of one folder in one snapshot: folders first, mails newest first, files by name. */
export async function listTree(
  db: Database,
  tenantId: string,
  reader: SnapshotReader,
  snapshotId: string,
  query: TreeQuery,
): Promise<TreeDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const loaded = await loadSnapshotForViewer(tx, tenantId, reader, snapshotId);
    const owned = ownedObject(loaded.object, loaded.ownerEmail);
    const { entries, total } = await queryListing(
      tx,
      {
        tenantId,
        snapshotId,
        objectId: loaded.object.id,
        sequence: loaded.snapshot.sequence,
        path: query.path,
        includeDeleted: query.includeDeleted,
        foldersOnly: query.foldersOnly,
        hideNativeVersions: loaded.object.kind === "onedrive" || loaded.object.kind === "site",
        sort: query.sort,
      },
      { limit: query.limit, offset: query.offset },
    );
    await auditRead(tx, tenantId, reader, {
      action: SNAPSHOT_AUDIT_ACTIONS.treeRead,
      target: snapshotId,
      targetType: "snapshot",
      onBehalfOf: onBehalfOfOwner(reader, owned),
      details: {
        ...objectDetails(loaded.object),
        snapshotSequence: loaded.snapshot.sequence,
        path: query.path,
        offset: query.offset,
        entries: entries.length,
        includeDeleted: query.includeDeleted,
      },
    });
    return {
      snapshot: toSnapshotDto(loaded.snapshot),
      object: {
        id: loaded.object.id,
        kind: loaded.object.kind,
        externalId: loaded.object.externalId,
        displayName: loaded.object.displayName,
        own: isOwnObject(reader, owned),
      },
      folder: { path: query.path, name: baseNameOf(query.path) },
      breadcrumb: breadcrumbOf(query.path),
      entries,
      total,
      offset: query.offset,
      hasMore: query.offset + entries.length < total,
    };
  });
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * The version history of one item: the same path (and optionally the same
 * source item id, so a moved item keeps its history) across every completed
 * snapshot of the object, plus the versions the source itself kept when a
 * snapshot is named.
 */
export async function listVersions(
  db: Database,
  tenantId: string,
  reader: SnapshotReader,
  objectId: string,
  query: VersionsQuery,
): Promise<VersionsDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const { object, ownerEmail } = await loadObjectForViewer(tx, tenantId, reader, objectId);
    const match = query.itemId
      ? sql`(m.path = ${query.path} OR m.item_id = ${query.itemId})`
      : sql`m.path = ${query.path}`;
    const completedOfObject = sql`s.protected_object_id = ${objectId}::uuid
      AND s.status = 'active' AND s.manifest_path IS NOT NULL`;
    const rows = await tx.execute<RawEntryRow>(sql`
      SELECT m.* FROM ${manifestEntries({ tenantId, snapshots: completedOfObject, chunks: true })} AS m
      WHERE m.protected_object_id = ${objectId}::uuid AND m.kind <> 'folder' AND ${match}
      ORDER BY m.snapshot_sequence DESC
      LIMIT ${query.limit}
    `);

    const versionRows: VersionRow[] = rows.rows.map((raw) => {
      const row = fromRawEntry(raw);
      return {
        objectId: row.id,
        snapshotId: raw.snapshot_id,
        sequence: Number(raw.snapshot_sequence),
        snapshotAt: iso(raw.snapshot_completed_at),
        path: row.path,
        name: row.name,
        kind: row.kind,
        size: row.size,
        mtime: iso(row.mtime),
        itemId: row.itemId,
        deleted: row.deleted,
        fingerprint: fingerprintOf({ ...row, chunkRefs: chunkRefsOf(raw) }),
      };
    });

    let stored: StoredVersionDto[] = [];
    if (query.snapshotId) {
      await loadSnapshotForViewer(tx, tenantId, reader, query.snapshotId);
      const storedRows = await tx.execute<RawEntryRow>(sql`
        SELECT m.* FROM ${snapshotEntries(tenantId, [query.snapshotId])} AS m
        WHERE m.protected_object_id = ${objectId}::uuid
          -- In byte order, so it is a lookup in manifest_versions_object_parent_idx.
          AND (m.parent_path COLLATE "C") = ${nativeVersionsParent(query.path)}
        ORDER BY m.mtime DESC
        LIMIT ${query.limit}
      `);
      stored = storedRows.rows.map((raw) => toStoredVersion(fromRawEntry(raw)));
    }

    await auditRead(tx, tenantId, reader, {
      action: SNAPSHOT_AUDIT_ACTIONS.versionsRead,
      target: objectId,
      targetType: "protected_object",
      onBehalfOf: onBehalfOfOwner(reader, ownedObject(object, ownerEmail)),
      details: {
        ...objectDetails(object),
        path: query.path,
        ...(query.snapshotId ? { snapshotId: query.snapshotId } : {}),
        versions: versionRows.length,
        storedVersions: stored.length,
      },
    });
    return {
      objectId,
      path: query.path,
      versions: collapseVersions(versionRows),
      stored,
    };
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** The newest completed snapshot id of each visible object (or of one object). */
async function latestSnapshotIds(
  tx: DbExecutor,
  tenantId: string,
  viewer: Viewer,
  objectId: string | undefined,
): Promise<string[]> {
  const visible = visibleObjectsCondition(viewer);
  const rows = await tx
    .select({
      latest: sql<string>`(array_agg(${snapshots.id} order by ${snapshots.sequence} desc))[1]`,
    })
    .from(snapshots)
    .innerJoin(protectedObjects, eq(protectedObjects.id, snapshots.protectedObjectId))
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        completedSnapshot(),
        ...(objectId ? [eq(snapshots.protectedObjectId, objectId)] : []),
        ...(visible ? [visible] : []),
      ),
    )
    .groupBy(snapshots.protectedObjectId);
  return rows.map((row) => row.latest).filter((id): id is string => typeof id === "string");
}

/** What a search covers, and how the audit log names it. */
interface SearchScope {
  snapshotIds: string[];
  audit: Pick<ReadEvent, "target" | "targetType" | "onBehalfOf">;
  object: ProtectedObject | null;
}

/** Resolve the snapshots a search covers: one named snapshot, else the latest of one or every visible object. */
async function searchScope(
  tx: DbExecutor,
  tenantId: string,
  reader: SnapshotReader,
  query: SearchQuery,
): Promise<SearchScope> {
  if (query.snapshotId) {
    const loaded = await loadSnapshotForViewer(tx, tenantId, reader, query.snapshotId);
    return {
      snapshotIds: [query.snapshotId],
      audit: {
        target: query.snapshotId,
        targetType: "snapshot",
        onBehalfOf: onBehalfOfOwner(reader, ownedObject(loaded.object, loaded.ownerEmail)),
      },
      object: loaded.object,
    };
  }
  if (query.objectId) {
    const loaded = await loadObjectForViewer(tx, tenantId, reader, query.objectId);
    return {
      snapshotIds: await latestSnapshotIds(tx, tenantId, reader, query.objectId),
      audit: {
        target: query.objectId,
        targetType: "protected_object",
        onBehalfOf: onBehalfOfOwner(reader, ownedObject(loaded.object, loaded.ownerEmail)),
      },
      object: loaded.object,
    };
  }
  // Every visible object: an admin's hits name their objects in the audit details.
  return {
    snapshotIds: await latestSnapshotIds(tx, tenantId, reader, undefined),
    audit: { target: tenantId, targetType: "tenant", onBehalfOf: null },
    object: null,
  };
}

/** Match names, paths, subjects and senders in the given snapshots. */
async function searchSnapshots(
  tx: DbExecutor,
  tenantId: string,
  snapshotIds: string[],
  query: SearchQuery,
): Promise<SearchDto> {
  if (snapshotIds.length === 0) {
    return { query: query.q, hits: [], searchedSnapshots: 0, truncated: false };
  }
  const pattern = `%${escapeLike(query.q)}%`;
  const ilike = (expression: SQL) => sql`${expression} ilike ${pattern} escape '\\'`;
  const metadataField = (key: string) => sql`m.metadata ->> ${key}::text`;
  const result = await tx.execute<RawEntryRow>(sql`
    SELECT m.* FROM ${snapshotEntries(tenantId, snapshotIds)} AS m
    WHERE ${metadataField(ATTACHMENT_PARENT_KEY)} IS NULL
      AND ${notAttachmentsFolder("m")}
      AND strpos(m.path, ${NATIVE_VERSION_MARKER}::text) = 0
      AND (${sql.join(
        [
          ilike(sql`m.name`),
          ilike(sql`m.path`),
          ilike(metadataField("subject")),
          ilike(metadataField("from")),
          ilike(metadataField("sender")),
          ilike(metadataField("to")),
          ilike(metadataField("toRecipients")),
          ilike(metadataField("cc")),
        ],
        sql` OR `,
      )})
    ORDER BY m.path
    LIMIT ${query.limit + 1}
  `);
  const rows = result.rows;

  const truncated = rows.length > query.limit;
  const hits: SearchHitDto[] = rows.slice(0, query.limit).map((row) => ({
    ...toTreeEntry(fromRawEntry(row)),
    snapshotId: row.snapshot_id,
    objectId: row.protected_object_id,
  }));
  hits.sort(compareEntries);
  return { query: query.q, hits, searchedSnapshots: snapshotIds.length, truncated };
}

/** Search names, paths, subjects and senders in the latest (or one given) snapshot. */
export async function search(
  db: Database,
  tenantId: string,
  reader: SnapshotReader,
  query: SearchQuery,
): Promise<SearchDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const scope = await searchScope(tx, tenantId, reader, query);
    const result = await searchSnapshots(tx, tenantId, scope.snapshotIds, query);
    await auditRead(tx, tenantId, reader, {
      action: SNAPSHOT_AUDIT_ACTIONS.searched,
      ...scope.audit,
      details: {
        ...(scope.object ? objectDetails(scope.object) : {}),
        query: query.q,
        searchedSnapshots: result.searchedSnapshots,
        hits: result.hits.length,
        truncated: result.truncated,
        matchedObjectIds: [...new Set(result.hits.map((hit) => hit.objectId))].sort(),
      },
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Mail preview and attachment download
// ---------------------------------------------------------------------------

type MailEntry = ReadableManifestEntry & { id: string; kind: ManifestObjectKind };

/** A mail entry of the snapshot; 404 for an unknown id or an entry that is not mail. */
async function loadMailEntry(
  tx: DbExecutor,
  tenantId: string,
  snapshotId: string,
  entryId: string,
): Promise<MailEntry> {
  const result = await tx.execute<RawEntryRow>(sql`
    SELECT m.* FROM ${snapshotEntries(tenantId, [snapshotId], true)} AS m
    WHERE m.id = ${entryId}::uuid
    LIMIT 1
  `);
  const raw = result.rows[0];
  const row = raw ? { ...fromRawEntry(raw), chunkRefs: chunkRefsOf(raw) } : undefined;
  if (row?.kind !== "mail") {
    throw new ProblemError(404, "Mail entry not found");
  }
  return row;
}

function isOversizedFormat(metadata: Record<string, unknown> | null): boolean {
  const format = metadata?.format;
  return format === "json" || format === "parts";
}

/**
 * The problem returned when an entry's backup content cannot be read back
 * (missing or damaged chunks, an undecryptable pack): the same honest
 * `content-unavailable` problem on every path that reads content, preview or
 * attachment download alike, rather than a plain 404 that hides storage
 * damage behind "not found".
 */
function contentUnavailableProblem(path: string): ProblemError {
  return new ProblemError(404, "Message content not found", {
    type: "urn:restow:problem:content-unavailable",
    detail:
      "This message's content is missing or damaged in storage. Run a scrub to check the backup's storage targets.",
    extensions: { path },
  });
}

/** Every preview process is busy and the queue is full: the request can simply be repeated. */
function previewBusyProblem(): ProblemError {
  return new ProblemError(503, "Preview busy", {
    type: "urn:restow:problem:preview-busy",
    detail:
      "Many messages are being prepared for display at the moment. Try again in a few seconds.",
    extensions: { retryable: true },
  });
}

/**
 * The preview of one mail entry: protected or too-large mail never has its
 * content opened (the manifest's own metadata is enough to say so); anything
 * else is read from the chunk store and parsed (preview.ts).
 */
async function resolveMailPreview(
  tx: DbExecutor,
  tenantId: string,
  entry: MailEntry,
): Promise<MailPreviewDto> {
  const { protection } = mailSummaryOf(entry.metadata);
  if (protection) {
    return unavailablePreview(protection, entry.metadata);
  }
  if (isOversizedFormat(entry.metadata)) {
    return unavailablePreview("unsupported-format", entry.metadata);
  }
  if (entry.size > PREVIEW_SIZE_CAP_BYTES) {
    return unavailablePreview("too-large", entry.metadata);
  }
  try {
    const bytes = await readManifestObjectBytes(tx, tenantId, entry);
    return await previewInWorker(bytes);
  } catch (error) {
    if (error instanceof ContentUnavailableError) {
      throw contentUnavailableProblem(entry.path);
    }
    if (error instanceof PreviewUnreadableError) {
      // The message is stored fine; it could not be prepared for display in the time and memory
      // a preview gets. The manifest's own metadata still says who wrote it and what it is about.
      return unavailablePreview("unreadable", entry.metadata);
    }
    if (error instanceof PreviewBusyError) {
      throw previewBusyProblem();
    }
    throw error;
  }
}

/**
 * Preview of one mail entry: a sanitised HTML/text body and its attachment
 * list, or why it cannot be shown (too large, rights-protected, S/MIME
 * encrypted). Audited like every other read of backup content.
 */
export async function previewMailEntry(
  db: Database,
  tenantId: string,
  reader: SnapshotReader,
  snapshotId: string,
  entryId: string,
): Promise<MailPreviewDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const loaded = await loadSnapshotForViewer(tx, tenantId, reader, snapshotId);
    const owned = ownedObject(loaded.object, loaded.ownerEmail);
    const entry = await loadMailEntry(tx, tenantId, snapshotId, entryId);
    const preview = await resolveMailPreview(tx, tenantId, entry);

    await auditRead(tx, tenantId, reader, {
      action: SNAPSHOT_AUDIT_ACTIONS.mailPreviewed,
      target: entryId,
      targetType: "manifest_object",
      onBehalfOf: onBehalfOfOwner(reader, owned),
      details: {
        ...objectDetails(loaded.object),
        snapshotId,
        path: entry.path,
        previewable: preview.previewable,
        ...(preview.previewable ? {} : { reason: preview.reason }),
      },
    });
    return preview;
  });
}

export interface AttachmentDownloadDto {
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * One attachment of a mail entry, by the id its preview listed it under.
 * Audited like the preview itself; a message above the preview size cap, or
 * one without that attachment (including protected mail, which lists none),
 * is a 404 rather than revealing which case it was.
 */
export async function openAttachmentDownload(
  db: Database,
  tenantId: string,
  reader: SnapshotReader,
  snapshotId: string,
  entryId: string,
  attachmentId: string,
): Promise<AttachmentDownloadDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const loaded = await loadSnapshotForViewer(tx, tenantId, reader, snapshotId);
    const owned = ownedObject(loaded.object, loaded.ownerEmail);
    const entry = await loadMailEntry(tx, tenantId, snapshotId, entryId);

    // Mirrors resolveMailPreview's protection check: the manifest's own flag
    // is trusted here without opening content, same as the preview path.
    // findAttachment below also refuses on its own MIME-level detection, but
    // that is a second, independent check, not a substitute for this one — a
    // message the engines flagged whose MIME the detector happens to miss
    // must not still serve its attachments.
    if (mailSummaryOf(entry.metadata).protection) {
      throw new ProblemError(404, "Attachment not found");
    }
    if (entry.size > PREVIEW_SIZE_CAP_BYTES || isOversizedFormat(entry.metadata)) {
      throw new ProblemError(404, "Attachment not found");
    }
    let attachment: FoundAttachment | null;
    try {
      const bytes = await readManifestObjectBytes(tx, tenantId, entry);
      attachment = await findAttachmentInWorker(bytes, attachmentId);
    } catch (error) {
      if (error instanceof PreviewUnreadableError) {
        throw new ProblemError(422, "Attachment cannot be read", {
          type: "urn:restow:problem:preview-unreadable",
          detail:
            "The message could not be read in the time and memory a download gets, so the attachment cannot be extracted. Download the whole message and open it in a mail program instead.",
        });
      }
      if (error instanceof PreviewBusyError) {
        throw previewBusyProblem();
      }
      if (error instanceof ContentUnavailableError) {
        // Storage damage, not a missing attachment: the honest
        // content-unavailable problem, same as the preview path, rather than
        // a plain "not found" that hides it.
        throw contentUnavailableProblem(entry.path);
      }
      throw error;
    }
    if (!attachment) {
      throw new ProblemError(404, "Attachment not found");
    }

    await auditRead(tx, tenantId, reader, {
      action: SNAPSHOT_AUDIT_ACTIONS.attachmentDownloaded,
      target: entryId,
      targetType: "manifest_object",
      onBehalfOf: onBehalfOfOwner(reader, owned),
      details: {
        ...objectDetails(loaded.object),
        snapshotId,
        path: entry.path,
        attachmentId,
        filename: attachment.filename ?? null,
        size: attachment.size,
      },
    });

    return {
      filename: attachment.filename ?? "attachment",
      contentType: downloadContentType(attachment),
      content: attachment.content,
    };
  });
}

// ---------------------------------------------------------------------------
// Calendar view
// ---------------------------------------------------------------------------

/** One occurrence in a calendar view: a single event, or one of a series. */
export interface CalendarOccurrenceDto {
  /** The manifest entry it comes from (the series master for an occurrence of a series). */
  entryId: string;
  entryPath: string;
  /** The entry's own name, source item id and stored size, to open it in the details. */
  entryName: string;
  itemId: string | null;
  size: number;
  calendarName: string | null;
  /** `single`: an event of its own; `occurrence`/`exception`: one of a series, as stored. */
  kind: "single" | "occurrence" | "exception";
  subject: string | null;
  start: string;
  end: string;
  isAllDay: boolean;
  location: string | null;
  organizer: string | null;
  isCancelled: boolean;
}

export interface CalendarViewDto {
  snapshotId: string;
  path: string;
  from: string;
  to: string;
  /** Oldest first. */
  occurrences: CalendarOccurrenceDto[];
  /** More occurrences fall into the window than one view lists. */
  truncated: boolean;
  /**
   * Series that could not be opened (too many in the window, too large, or their content is
   * damaged): their occurrences are missing from the view, the list view still shows them.
   */
  unexpandedSeries: number;
}

/** The most occurrences one calendar view lists. */
export const CALENDAR_MAX_OCCURRENCES = 2000;
/** The most series one calendar view opens to expand them. */
export const CALENDAR_MAX_SERIES = 200;
/** A stored series above this size is not opened by a view (its JSON is read whole). */
const CALENDAR_SERIES_MAX_BYTES = 4 * 1024 * 1024;

interface StoredEventPayload {
  event?: RecurringEventLike;
  exceptions?: RecurringEventLike[];
}

function parseStoredEvent(bytes: Buffer): StoredEventPayload | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    // `{ event, exceptions }` since the calendar phase; a bare event from older engines.
    return "event" in parsed
      ? (parsed as StoredEventPayload)
      : { event: parsed as RecurringEventLike, exceptions: [] };
  } catch {
    return null;
  }
}

/**
 * The events of a mailbox's calendars below `path` (one calendar, or all of them below
 * `calendar`) that take place in `[from, to)`, every series expanded into its occurrences from
 * its pattern and its stored exceptions (packages/core calendar/recurrence.ts); with `entryId`,
 * the occurrences of that one series or event. Single events come from the manifest's own
 * metadata; a series is opened (its stored JSON read from the chunk store) to know its pattern,
 * at most {@link CALENDAR_MAX_SERIES} per view. Events the source had deleted by the time of the
 * restore point are left out. Audited like every other read of backup content.
 */
export async function calendarView(
  db: Database,
  tenantId: string,
  reader: SnapshotReader,
  snapshotId: string,
  query: CalendarQuery,
): Promise<CalendarViewDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const loaded = await loadSnapshotForViewer(tx, tenantId, reader, snapshotId);
    const owned = ownedObject(loaded.object, loaded.ownerEmail);
    const from = new Date(query.from);
    const to = new Date(query.to);
    const path = query.path;
    const start = eventStartExpression(sql`m.metadata`);
    const end = eventEndExpression(sql`m.metadata`);
    const master = sql`coalesce(m.metadata ->> 'eventType', '') = 'seriesMaster'`;
    const where = sql`
      m.kind = 'event' AND m.deleted = false
      AND ${
        query.entryId
          ? sql`m.id = ${query.entryId}::uuid`
          : // The byte-order range ['calendar', 'calendar0') holds the calendar and everything
            // below it (and a few siblings the exact test drops): one range of
            // manifest_versions_object_parent_idx instead of every entry of the mailbox.
            sql`(m.parent_path COLLATE "C") >= ${path}::text
                AND (m.parent_path COLLATE "C") < ${path}::text || '0'
                AND (m.parent_path = ${path}::text
                     OR left(m.parent_path, length(${path}::text) + 1) = ${path}::text || '/')`
      }`;

    const singles = await tx.execute<RawEntryRow & { event_start: Date | string }>(sql`
      SELECT m.*, ${start} AS event_start
      FROM ${snapshotEntries(tenantId, [snapshotId])} AS m
      WHERE ${where} AND NOT ${master}
        AND ${start} < ${to.toISOString()}::timestamptz
        AND greatest(coalesce(${end}, ${start}), ${start} + interval '1 second')
            > ${from.toISOString()}::timestamptz
      ORDER BY event_start, m.path
      LIMIT ${CALENDAR_MAX_OCCURRENCES + 1}
    `);
    // A series can only fall into the window once it has started and while its range lasts.
    const masters = await tx.execute<RawEntryRow>(sql`
      SELECT m.* FROM ${snapshotEntries(tenantId, [snapshotId], true)} AS m
      WHERE ${where} AND ${master}
        AND (${start} IS NULL OR ${start} < ${to.toISOString()}::timestamptz)
        AND (coalesce(m.metadata ->> 'recurrenceEnd', '') !~ '^\\d{4}-\\d{2}-\\d{2}$'
             OR (m.metadata ->> 'recurrenceEnd')::date >= ${from.toISOString()}::timestamptz::date)
      ORDER BY m.path
      LIMIT ${CALENDAR_MAX_SERIES + 1}
    `);

    const occurrences: CalendarOccurrenceDto[] = [];
    for (const raw of singles.rows.slice(0, CALENDAR_MAX_OCCURRENCES)) {
      const summary = eventSummaryOf(raw.metadata);
      if (!summary.start) {
        continue;
      }
      occurrences.push({
        entryId: raw.id,
        entryPath: raw.path,
        entryName: raw.name,
        itemId: raw.item_id,
        size: Number(raw.size),
        calendarName: summary.calendarName,
        kind:
          summary.type === "exception" || summary.type === "occurrence" ? summary.type : "single",
        subject: summary.subject,
        start: summary.start,
        end: summary.end ?? summary.start,
        isAllDay: summary.isAllDay,
        location: summary.location,
        organizer: summary.organizer,
        isCancelled: summary.isCancelled,
      });
    }
    let truncated = singles.rows.length > CALENDAR_MAX_OCCURRENCES;
    let unexpanded = Math.max(0, masters.rows.length - CALENDAR_MAX_SERIES);
    const opened = masters.rows.slice(0, CALENDAR_MAX_SERIES);
    const read = opened.length > 0 ? await openManifestObjectReader(tx, tenantId) : null;
    for (const raw of opened) {
      const entry = { ...fromRawEntry(raw), chunkRefs: chunkRefsOf(raw) };
      if (!read || entry.size > CALENDAR_SERIES_MAX_BYTES) {
        unexpanded += 1;
        continue;
      }
      let stored: StoredEventPayload | null = null;
      try {
        stored = parseStoredEvent(await read(entry));
      } catch (error) {
        if (!(error instanceof ContentUnavailableError)) {
          throw error;
        }
      }
      if (!stored?.event) {
        unexpanded += 1;
        continue;
      }
      const summary = eventSummaryOf(raw.metadata);
      const expansion = expandSeries(
        stored.event,
        stored.exceptions ?? [],
        { from: from.getTime(), to: to.getTime() },
        CALENDAR_MAX_OCCURRENCES,
      );
      truncated ||= expansion.truncated;
      for (const occurrence of expansion.occurrences) {
        occurrences.push({
          entryId: raw.id,
          entryPath: raw.path,
          entryName: raw.name,
          itemId: raw.item_id,
          size: Number(raw.size),
          calendarName: summary.calendarName,
          kind: occurrence.kind,
          subject: occurrence.subject,
          start: occurrence.start,
          end: occurrence.end,
          isAllDay: occurrence.isAllDay,
          location: occurrence.location,
          organizer: summary.organizer,
          isCancelled: occurrence.isCancelled,
        });
      }
    }
    occurrences.sort(
      (a, b) => Date.parse(a.start) - Date.parse(b.start) || a.entryPath.localeCompare(b.entryPath),
    );
    if (occurrences.length > CALENDAR_MAX_OCCURRENCES) {
      occurrences.length = CALENDAR_MAX_OCCURRENCES;
      truncated = true;
    }

    await auditRead(tx, tenantId, reader, {
      action: SNAPSHOT_AUDIT_ACTIONS.calendarRead,
      target: snapshotId,
      targetType: "snapshot",
      onBehalfOf: onBehalfOfOwner(reader, owned),
      details: {
        ...objectDetails(loaded.object),
        snapshotSequence: loaded.snapshot.sequence,
        path,
        from: from.toISOString(),
        to: to.toISOString(),
        ...(query.entryId ? { entryId: query.entryId } : {}),
        occurrences: occurrences.length,
        openedSeries: opened.length,
      },
    });
    return {
      snapshotId,
      path,
      from: from.toISOString(),
      to: to.toISOString(),
      occurrences,
      truncated,
      unexpandedSeries: unexpanded,
    };
  });
}

// ---------------------------------------------------------------------------
// People: the explorer's left column, page by page
// ---------------------------------------------------------------------------

/** One entry of the explorer's left column: a person with their objects, one site or one group mailbox. */
export interface PersonEntryDto {
  /** `user:<user id>`, `object:<id>` for an object of no known person, `site:<id>`, `group:<id>`. */
  key: string;
  name: string;
  /** The person's address (the owner's), or null. */
  address: string | null;
  own: boolean;
  /** Every object of the entry is orphaned (the account is gone from the directory). */
  accountDeleted: boolean;
  /** Mailbox first, then OneDrive, then IMAP accounts. */
  objects: SnapshotObjectDto[];
}

export interface PeoplePageDto {
  section: PeopleQuery["section"];
  items: PersonEntryDto[];
  /** Entries that match the search and filter, all pages together. */
  total: number;
  /** The cursor of the next page; null on the last one. */
  next: string | null;
}

interface PeopleCursor {
  own: boolean;
  name: string;
  key: string;
}

function encodeCursor(cursor: PeopleCursor): string {
  return Buffer.from(JSON.stringify([cursor.own ? 0 : 1, cursor.name, cursor.key])).toString(
    "base64url",
  );
}

function decodeCursor(value: string): PeopleCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      (parsed[0] === 0 || parsed[0] === 1) &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string"
    ) {
      return { own: parsed[0] === 0, name: parsed[1], key: parsed[2] };
    }
  } catch {
    // Falls through to the problem below.
  }
  throw new ProblemError(400, "Invalid cursor", {
    detail: "The cursor does not come from a previous page of this list.",
  });
}

const KIND_RANK: Readonly<Record<string, number>> = {
  mailbox: 0,
  onedrive: 1,
  imap: 2,
  site: 3,
  group: 4,
};

/**
 * The explorer's left column one page at a time, for tenants with tens of thousands of people:
 * people grouped by the directory user their objects belong to (`protected_objects.user_id`),
 * or sites and Microsoft 365 group mailboxes (the "SharePoint & Teams" section), the viewer's own entry first, then by name and key (a keyset, stable while objects
 * come and go). Search and the type filter run in the database over every name, address and
 * account id. The grouping reads the tenant's objects through `protected_objects_tenant_status_idx`
 * once per page; the objects of the page (their restore points and readiness) are loaded by id.
 */
export async function listPeople(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  query: PeopleQuery,
): Promise<PeoplePageDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const visible = visibleObjectsCondition(viewer);
    const email = normalizeEmail(viewer.email);
    const own =
      email.length === 0
        ? sql`false`
        : sql`(lower(u.email) = ${email} OR lower(po.external_id) = ${email})`;
    const section =
      query.objectId !== undefined
        ? sql`true`
        : query.section === "sites"
          ? sql`po.kind IN ('site', 'group')`
          : sql`po.kind NOT IN ('site', 'group')`;
    const withBackup =
      query.include === "all"
        ? sql`true`
        : sql`EXISTS (SELECT 1 FROM snapshots sn WHERE sn.protected_object_id = po.id
                        AND sn.status = 'active' AND sn.manifest_path IS NOT NULL)`;
    const visibility = visible
      ? sql`(lower(u.email) = ${email} OR lower(po.external_id) = ${email})`
      : sql`true`;

    const filters: SQL[] = [];
    if (query.kind) {
      filters.push(sql`bool_or(o.kind = ${query.kind})`);
    }
    const words = query.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    for (const word of words) {
      filters.push(sql`bool_or(o.hay LIKE ${`%${escapeLike(word)}%`})`);
    }
    if (query.objectId) {
      filters.push(sql`bool_or(o.id = ${query.objectId}::uuid)`);
    }
    const having = filters.length > 0 ? sql`HAVING ${sql.join(filters, sql` AND `)}` : sql``;
    const cursor = query.after && !query.objectId ? decodeCursor(query.after) : null;
    const after = cursor
      ? sql`WHERE (g.rank, g.sort_name, g.key) > (${cursor.own ? 0 : 1}, ${cursor.name}, ${cursor.key})`
      : sql``;

    const result = await tx.execute<{
      key: string;
      name: string;
      sort_name: string;
      own: boolean;
      ids: string[];
      total: number;
    }>(sql`
      WITH o AS (
        SELECT po.id, po.kind, po.status,
               CASE WHEN po.kind = 'site' THEN 'site:' || po.id::text
                    WHEN po.kind = 'group' THEN 'group:' || po.id::text
                    WHEN po.user_id IS NOT NULL THEN 'user:' || po.user_id::text
                    ELSE 'object:' || po.id::text END AS key,
               u.display_name AS owner_name,
               coalesce(po.display_name, po.external_id) AS label,
               ${own} AS own,
               lower(concat_ws(' ', po.display_name, po.external_id, u.email, u.display_name, u.upn)) AS hay
        FROM protected_objects po
        LEFT JOIN users u ON u.id = po.user_id
        WHERE po.tenant_id = ${tenantId}::uuid AND ${section} AND ${visibility} AND ${withBackup}
      ),
      g AS (
        SELECT o.key,
               coalesce(max(o.owner_name), min(o.label) FILTER (WHERE o.kind <> 'imap'), min(o.label)) AS name,
               CASE WHEN bool_or(o.own) THEN 0 ELSE 1 END AS rank,
               bool_or(o.own) AS own,
               array_agg(o.id::text) AS ids
        FROM o
        GROUP BY o.key
        ${having}
      ),
      ranked AS (
        SELECT g.*, lower(g.name) AS sort_name, count(*) OVER () AS total FROM g
      )
      SELECT g.key, g.name, g.sort_name, g.own, g.ids, g.total::int AS total
      FROM ranked g
      ${after}
      ORDER BY g.rank, g.sort_name, g.key
      LIMIT ${query.objectId ? 1 : query.limit + 1}
    `);
    // `total` is counted before the cursor applies: on a later page it still counts all matches.
    const rows = result.rows.slice(0, query.objectId ? 1 : query.limit);
    const objects = await selectObjects(
      tx,
      tenantId,
      viewer,
      query.include,
      rows.flatMap((row) => row.ids),
    );
    const byId = new Map(objects.map((object) => [object.id, object]));
    const items = rows.map((row): PersonEntryDto => {
      const list = row.ids
        .map((id) => byId.get(id))
        .filter((object): object is SnapshotObjectDto => object !== undefined)
        .sort(
          (a, b) =>
            (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
            (a.displayName ?? a.externalId).localeCompare(b.displayName ?? b.externalId),
        );
      const first = list[0];
      return {
        key: row.key,
        name: row.name,
        address: first?.ownerEmail ?? null,
        own: row.own,
        // A disabled or unlicensed account still exists: it is not "deleted".
        accountDeleted:
          list.length > 0 &&
          list.every((object) => object.status === "orphaned" && object.statusReason === null),
        objects: list,
      };
    });
    const last = rows[rows.length - 1];
    const more = !query.objectId && result.rows.length > query.limit;
    return {
      section: query.section,
      items,
      total: Number(result.rows[0]?.total ?? 0),
      next:
        more && last ? encodeCursor({ own: last.own, name: last.sort_name, key: last.key }) : null,
    };
  });
}
