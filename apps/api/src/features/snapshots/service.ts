import {
  type Database,
  type ManifestObjectKind,
  type ProtectedObject,
  type Source,
  manifestObjects,
  protectedObjects,
  snapshots,
  sources,
  users,
} from "@restow/db";
import { type SQL, and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { type AuditEvent, audit } from "../../lib/audit.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { ObjectState } from "../verify/summary.js";
import {
  type SnapshotVerificationDto,
  loadObjectVerifications,
  loadSnapshotVerifications,
  unverifiedSnapshot,
} from "../verify/verification-state.js";
import {
  type OwnedObject,
  type Viewer,
  canAccessObject,
  isOwnObject,
  onBehalfOfOwner,
  visibleObjectsCondition,
} from "./access.js";
import {
  ContentUnavailableError,
  type ReadableManifestEntry,
  readManifestObjectBytes,
} from "./content.js";
import {
  PreviewBusyError,
  PreviewUnreadableError,
  findAttachmentInWorker,
  previewInWorker,
} from "./preview-isolated.js";
import {
  type FoundAttachment,
  type MailPreviewDto,
  PREVIEW_SIZE_CAP_BYTES,
  downloadContentType,
  unavailablePreview,
} from "./preview.js";
import type {
  ListObjectsQuery,
  ListSnapshotsQuery,
  SearchQuery,
  TreeQuery,
  VersionsQuery,
} from "./schemas.js";
import {
  ATTACHMENT_PARENT_KEY,
  type BreadcrumbSegment,
  type EntryRow,
  NATIVE_VERSION_MARKER,
  type StoredVersionDto,
  type TreeEntryDto,
  type VersionDto,
  type VersionRow,
  baseNameOf,
  breadcrumbOf,
  collapseVersions,
  compareEntries,
  escapeLike,
  fingerprintOf,
  mailSummaryOf,
  nativeVersionsParent,
  toStoredVersion,
  toTreeEntry,
} from "./tree.js";

/**
 * Snapshot browsing for the restore explorer (docs/ARCHITECTURE.md, restore and
 * file explorer section). Everything reads the Postgres mirror of the manifests
 * (`manifest_objects`); the manifest in storage stays the truth for the
 * standalone restore. Every query runs in a tenant-pinned transaction (RLS)
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
  /** m365 or imap: which source backs this object up, for the explorer's grouping. */
  sourceKind: Source["kind"];
  ownerEmail: string | null;
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
  return withTenantTx(db, tenantId, async (tx) => {
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
        sourceKind: sources.kind,
        ownerEmail: users.email,
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
          ...(query.include === "all" ? [] : [isNotNull(snapshots.id)]),
        ),
      )
      .groupBy(protectedObjects.id, sources.kind, users.email)
      .orderBy(
        sql`lower(coalesce(${protectedObjects.displayName}, ${protectedObjects.externalId}))`,
      );

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
      sourceKind: row.sourceKind,
      ownerEmail: row.ownerEmail,
      own: isOwnObject(viewer, row),
      snapshotCount: Number(row.snapshotCount),
      latestSnapshotId: row.latestSnapshotId,
      latestSnapshotAt: iso(row.latestSnapshotAt),
      readiness: verifications.get(row.id)?.verification.state ?? "no_backup",
    }));
  });
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

interface ListingScope {
  tenantId: string;
  snapshotId: string;
  path: string;
  includeDeleted: boolean;
  foldersOnly: boolean;
  /** Hide OneDrive's `<file>:versions/<id>` objects (they belong to the version panel). */
  hideNativeVersions: boolean;
  /** `date` (default): mail newest first, folders first. `name`: everything by name, folders first. */
  sort: "date" | "name";
}

/** The raw shape of a listing row (see {@link listingCte}). */
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
 * `mtime` alone is the wrong default for Exchange mail: `manifest_objects.mtime`
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
 * The children of one folder as a `listing` CTE: the rows whose parent is the
 * folder, plus one synthetic folder for every child segment that only exists
 * as a parent of deeper rows. Backups do not record every folder (area roots
 * like `mail` or `calendar` have no row of their own), and without these the
 * explorer could not reach anything below them. Attachments of JSON-format
 * messages and OneDrive's own version objects are not browsed.
 */
function listingCte(scope: ListingScope): SQL {
  const path = sql`${scope.path}::text`;
  const filters: SQL[] = [
    sql`m.tenant_id = ${scope.tenantId}::uuid`,
    sql`m.snapshot_id = ${scope.snapshotId}::uuid`,
    sql`(m.metadata ->> ${ATTACHMENT_PARENT_KEY}::text) IS NULL`,
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
      FROM manifest_objects m
      WHERE ${sql.join(filters, sql` AND `)}
    ),
    direct AS (
      SELECT s.id::text AS id, s.kind, s.name, s.path, s.parent_path, s.size, s.mtime,
             s.item_id, s.deleted, s.metadata,
             ${mailDateExpression(sql`s.metadata`, sql`s.mtime`)} AS mail_date, false AS implicit
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
             NULL::timestamptz AS mail_date, true AS implicit
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
 * dated mail newest first (by `mail_date`, the listing CTE's precomputed
 * {@link mailDateExpression}, not the raw `mtime`), everything else (undated
 * mail, files, events, contacts) in natural name order; `sort: "name"` puts
 * everything in natural name order, mail included. See {@link compareEntries}
 * for the equivalent in-memory order used for search hits.
 */
function listingOrder(sort: "date" | "name"): SQL {
  const byDate = sort === "date" ? sql`true` : sql`false`;
  return sql`
    ORDER BY CASE WHEN kind = 'folder' THEN 0 ELSE 1 END,
             CASE WHEN ${byDate} AND kind = 'mail' AND mail_date IS NOT NULL THEN 0 ELSE 1 END,
             CASE WHEN ${byDate} AND kind = 'mail' THEN mail_date END DESC,
             ${naturalSortKey(sql`name`)}, path
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

/** One page of a folder's children, with the total for paging. */
export async function queryListing(
  tx: DbExecutor,
  scope: ListingScope,
  page: { limit: number; offset: number },
): Promise<{ entries: TreeEntryDto[]; total: number }> {
  const listing = listingCte(scope);
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
        path: query.path,
        includeDeleted: query.includeDeleted,
        foldersOnly: query.foldersOnly,
        hideNativeVersions: loaded.object.kind === "onedrive",
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
    const matchesPath = eq(manifestObjects.path, query.path);
    const match = query.itemId
      ? (or(matchesPath, eq(manifestObjects.itemId, query.itemId)) as SQL)
      : matchesPath;
    const rows = await tx
      .select({
        object: manifestObjects,
        snapshotId: snapshots.id,
        sequence: snapshots.sequence,
        completedAt: snapshots.completedAt,
      })
      .from(manifestObjects)
      .innerJoin(snapshots, eq(snapshots.id, manifestObjects.snapshotId))
      .where(
        and(
          eq(manifestObjects.tenantId, tenantId),
          eq(manifestObjects.protectedObjectId, objectId),
          ne(manifestObjects.kind, "folder"),
          match,
          completedSnapshot(),
        ),
      )
      .orderBy(desc(snapshots.sequence))
      .limit(query.limit);

    const versionRows: VersionRow[] = rows.map((row) => ({
      objectId: row.object.id,
      snapshotId: row.snapshotId,
      sequence: row.sequence,
      snapshotAt: iso(row.completedAt),
      path: row.object.path,
      name: row.object.name,
      kind: row.object.kind,
      size: row.object.size,
      mtime: iso(row.object.mtime),
      itemId: row.object.itemId,
      deleted: row.object.deleted,
      fingerprint: fingerprintOf(row.object),
    }));

    let stored: StoredVersionDto[] = [];
    if (query.snapshotId) {
      await loadSnapshotForViewer(tx, tenantId, reader, query.snapshotId);
      const storedRows = await tx
        .select({
          path: manifestObjects.path,
          name: manifestObjects.name,
          size: manifestObjects.size,
          mtime: manifestObjects.mtime,
          metadata: manifestObjects.metadata,
        })
        .from(manifestObjects)
        .where(
          and(
            eq(manifestObjects.tenantId, tenantId),
            eq(manifestObjects.snapshotId, query.snapshotId),
            eq(manifestObjects.protectedObjectId, objectId),
            eq(manifestObjects.parentPath, nativeVersionsParent(query.path)),
          ),
        )
        .orderBy(desc(manifestObjects.mtime))
        .limit(query.limit);
      stored = storedRows.map(toStoredVersion);
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

const entryColumns = {
  id: manifestObjects.id,
  kind: manifestObjects.kind,
  name: manifestObjects.name,
  path: manifestObjects.path,
  parentPath: manifestObjects.parentPath,
  size: manifestObjects.size,
  mtime: manifestObjects.mtime,
  itemId: manifestObjects.itemId,
  deleted: manifestObjects.deleted,
  metadata: manifestObjects.metadata,
};

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
  const metadataField = (key: string) => sql`${manifestObjects.metadata} ->> ${key}::text`;
  const rows = await tx
    .select({
      ...entryColumns,
      snapshotId: manifestObjects.snapshotId,
      objectId: manifestObjects.protectedObjectId,
    })
    .from(manifestObjects)
    .where(
      and(
        eq(manifestObjects.tenantId, tenantId),
        inArray(manifestObjects.snapshotId, snapshotIds),
        sql`${metadataField(ATTACHMENT_PARENT_KEY)} IS NULL`,
        sql`strpos(${manifestObjects.path}, ${NATIVE_VERSION_MARKER}::text) = 0`,
        or(
          ilike(sql`${manifestObjects.name}`),
          ilike(sql`${manifestObjects.path}`),
          ilike(metadataField("subject")),
          ilike(metadataField("from")),
          ilike(metadataField("sender")),
          ilike(metadataField("to")),
          ilike(metadataField("toRecipients")),
          ilike(metadataField("cc")),
        ),
      ),
    )
    .orderBy(manifestObjects.path)
    .limit(query.limit + 1);

  const truncated = rows.length > query.limit;
  const hits: SearchHitDto[] = rows.slice(0, query.limit).map((row) => ({
    ...toTreeEntry(row),
    snapshotId: row.snapshotId,
    objectId: row.objectId,
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
  const [row] = await tx
    .select({
      id: manifestObjects.id,
      kind: manifestObjects.kind,
      path: manifestObjects.path,
      size: manifestObjects.size,
      mtime: manifestObjects.mtime,
      itemId: manifestObjects.itemId,
      chunkRefs: manifestObjects.chunkRefs,
      metadata: manifestObjects.metadata,
    })
    .from(manifestObjects)
    .where(
      and(
        eq(manifestObjects.tenantId, tenantId),
        eq(manifestObjects.snapshotId, snapshotId),
        eq(manifestObjects.id, entryId),
      ),
    )
    .limit(1);
  if (!row || row.kind !== "mail") {
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
