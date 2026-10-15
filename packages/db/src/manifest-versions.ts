/**
 * The manifest index as versions (schema/manifest.ts, `manifest_versions`).
 *
 * A version row holds one state of one object for the snapshots of its
 * protected object whose sequence lies in `[first_sequence, last_sequence]`;
 * `last_sequence` is {@link OPEN_SEQUENCE} while the object is unchanged in
 * the newest mirrored snapshot. The invariant every function here keeps:
 *
 *   for every completed active snapshot S without old per-snapshot rows, the
 *   rows covering S.sequence are exactly S's objects (as a multiset, every
 *   mirrored column equal).
 *
 * Rows may also cover sequences of snapshots that are pruned, discarded,
 * still running, not created yet, or not converted from the 0.3.4 mirror
 * yet; nothing reads those from the versions. A running snapshot is always
 * mirrored right before it completes (the engine writes the mirror, then
 * completes the row, on every commit attempt), and a snapshot with old rows
 * is read from those until its conversion, so only the snapshots named above
 * need the invariant ("completed" below means exactly those).
 *
 * Mirroring snapshot S (sequence n) is a diff against the rows covering n,
 * matched by a hash of every mirrored column (`content_hash`):
 *
 *   - an object that matches a covering row costs nothing: an unchanged
 *     mailbox writes no row at all,
 *   - an object without one extends an identical row that ended just before
 *     n (its range ends at or after p, the newest completed snapshot before
 *     S: only sequences without a completed snapshot become newly covered),
 *     or gets a new row,
 *   - a covering row no object matched (removed or changed at the source)
 *     stops covering n: it is closed at n - 1, deleted when it covered only
 *     n, and split when a completed snapshot after n still needs it,
 *   - new and extended rows stay open when S is the newest completed
 *     snapshot; otherwise they end at n and are merged with identical rows
 *     that start after n, so mirroring out of order (a retried commit, the
 *     background conversion of older snapshots) stays exact and compact.
 *
 * Mirroring is idempotent per snapshot. All of it runs in the caller's
 * tenant-pinned transaction, under a transaction-scoped advisory lock per
 * protected object, so the writer, the background conversion and retention
 * never interleave on one object. The objects are streamed in batches: the
 * diff holds only (id, hash, range) of the covering rows in memory.
 *
 * The per-snapshot mirror of 0.3.4 (`manifest_objects`) is still read next to
 * the versions until the conversion ({@link convertLegacySnapshot}) has
 * folded it in; {@link manifestEntries} is the one place that combines both.
 */
import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { chunkIdArrayLiteral, chunkIdBytes, type ManifestObjectKind } from "./schema/manifest.js";

/** Anything that runs a raw statement: a Drizzle database or transaction. */
export type ManifestExecutor = Pick<NodePgDatabase<Record<string, unknown>>, "execute">;

/** `last_sequence` of a version that holds up to the newest mirrored snapshot. */
export const OPEN_SEQUENCE = 2147483647;

/**
 * Metadata keys the backup engines record for their own bookkeeping (delta
 * carry-over, Graph and IMAP addressing, content hashes of the source). No
 * reader of the index uses them (explorer, search, preview, restore and
 * export selection, version history); the manifest file in storage keeps
 * them, and the restore engines read them from there. A reader that starts
 * needing one of them must take it out of this list (and the older versions
 * of the index will not have it).
 */
export const MIRROR_OMITTED_METADATA_KEYS = [
  // Exchange (packages/core backup/exchange/run.ts META).
  "folderId",
  "calendarId",
  "fingerprint",
  "fetchedInSnapshot",
  "messageItemId",
  // IMAP (packages/core backup/imap/paths.ts META).
  "mailbox",
  "delimiter",
  "specialUse",
  "uid",
  "uidValidity",
  "reportedSize",
  // OneDrive (packages/core backup/onedrive/items.ts).
  "parentId",
  "webUrl",
  "sourceSize",
  "quickXorHash",
  "sha1Hash",
  "sha256Hash",
  "remoteDriveId",
  "remoteItemId",
  "remoteWebUrl",
] as const;

const OMITTED = new Set<string>(MIRROR_OMITTED_METADATA_KEYS);

/** The metadata the index keeps of an entry (see {@link MIRROR_OMITTED_METADATA_KEYS}). */
export function mirrorMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (metadata === null || metadata === undefined) {
    return null;
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!OMITTED.has(key)) {
      kept[key] = value;
    }
  }
  return kept;
}

/** One object of a snapshot as the index stores it. */
export interface ManifestMirrorEntry {
  readonly kind: ManifestObjectKind;
  readonly path: string;
  readonly name: string;
  readonly parentPath: string;
  readonly size: number;
  readonly mtime: Date | null;
  readonly itemId: string | null;
  readonly messageId: string | null;
  /** Ordered stored chunk ids (hex); null for folders. */
  readonly chunkRefs: readonly string[] | null;
  /** Mirrored as given except for {@link MIRROR_OMITTED_METADATA_KEYS}. */
  readonly metadata: Record<string, unknown> | null;
  readonly deleted?: boolean;
}

export interface MirrorScope {
  readonly tenantId: string;
  readonly protectedObjectId: string;
  readonly snapshotId: string;
  readonly sequence: number;
}

export interface MirrorOutcome {
  /** Objects already covered by an identical version: nothing written. */
  readonly unchanged: number;
  /** Objects whose identical version from an earlier snapshot was extended. */
  readonly extended: number;
  /** Objects that got a new version row. */
  readonly inserted: number;
  /** Versions that stopped covering this snapshot (removed or changed at the source). */
  readonly removed: number;
  /** Versions merged with an identical one of a later snapshot. */
  readonly merged: number;
}

/** Objects per statement when writing (13 parameters each). */
const WRITE_BATCH = 1000;
/** Old per-snapshot rows read per page when converting. */
const CONVERT_PAGE = 2000;
/** Row ids per statement when closing versions. */
const ID_BATCH = 5000;

const OMITTED_KEYS_SQL = sql.raw(
  `ARRAY[${MIRROR_OMITTED_METADATA_KEYS.map((key) => `'${key}'`).join(", ")}]::text[]`,
);

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** An entry as stored: metadata trimmed, chunk ids normalised, with its content hash. */
interface StoredEntry {
  readonly kind: ManifestObjectKind;
  readonly path: string;
  readonly name: string;
  readonly parentPath: string;
  readonly size: number;
  readonly mtime: Date | null;
  readonly itemId: string | null;
  readonly messageId: string | null;
  readonly chunkRefs: string[] | null;
  readonly metadata: Record<string, unknown> | null;
  readonly deleted: boolean;
  /** Hex of the 16-byte content hash. */
  readonly hash: string;
}

/**
 * The entry as the index stores it, and the hash of every stored column: two
 * entries with the same hash are the same version. 128 bits of SHA-256 over
 * a canonical encoding; the hash is only ever compared within one protected
 * object.
 */
export function storedEntry(entry: ManifestMirrorEntry): StoredEntry {
  const chunkRefs = entry.chunkRefs
    ? entry.chunkRefs.map((id) => chunkIdBytes(id).toString("hex"))
    : null;
  const metadata = mirrorMetadata(entry.metadata);
  const mtime = entry.mtime && !Number.isNaN(entry.mtime.getTime()) ? entry.mtime : null;
  const deleted = entry.deleted === true;
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        entry.kind,
        entry.path,
        entry.name,
        entry.parentPath,
        entry.size,
        mtime ? mtime.getTime() : null,
        entry.itemId,
        entry.messageId,
        chunkRefs,
        canonical(metadata),
        deleted,
      ]),
    )
    .digest()
    .subarray(0, 16)
    .toString("hex");
  return { ...entry, chunkRefs, metadata, mtime, deleted, hash };
}

/** Serialize all index writes for one protected object (writer, conversion, retention). */
async function lockObject(tx: ManifestExecutor, protectedObjectId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`manifest-versions:${protectedObjectId}`}))`,
  );
}

/**
 * A snapshot whose objects the versions describe: one with old per-snapshot
 * rows left is read from those (and the versions may cover its sequence
 * with anything until it is converted), like a snapshot that is still running.
 */
const VERSIONED = sql.raw(
  "NOT EXISTS (SELECT 1 FROM manifest_objects legacy WHERE legacy.snapshot_id = snapshots.id)",
);

/** The newest completed, versioned active snapshot of the object before `sequence`, if any. */
async function previousCompleted(tx: ManifestExecutor, scope: MirrorScope): Promise<number | null> {
  const result = await tx.execute(sql`
    SELECT max(sequence)::int AS sequence FROM snapshots
    WHERE tenant_id = ${scope.tenantId}::uuid
      AND protected_object_id = ${scope.protectedObjectId}::uuid
      AND status = 'active' AND manifest_path IS NOT NULL
      AND sequence < ${scope.sequence}::int AND ${VERSIONED}
  `);
  const value = rowsOf<{ sequence: number | null }>(result)[0]?.sequence;
  return value === null || value === undefined ? null : Number(value);
}

/** The oldest completed, versioned active snapshot of the object after `sequence`, if any. */
async function nextCompleted(tx: ManifestExecutor, scope: MirrorScope): Promise<number | null> {
  const result = await tx.execute(sql`
    SELECT min(sequence)::int AS sequence FROM snapshots
    WHERE tenant_id = ${scope.tenantId}::uuid
      AND protected_object_id = ${scope.protectedObjectId}::uuid
      AND status = 'active' AND manifest_path IS NOT NULL
      AND sequence > ${scope.sequence}::int AND ${VERSIONED}
  `);
  const value = rowsOf<{ sequence: number | null }>(result)[0]?.sequence;
  return value === null || value === undefined ? null : Number(value);
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

function objectFilter(scope: MirrorScope, alias = ""): SQL {
  const prefix = alias ? `${alias}.` : "";
  return sql`${sql.raw(`${prefix}tenant_id`)} = ${scope.tenantId}::uuid
    AND ${sql.raw(`${prefix}protected_object_id`)} = ${scope.protectedObjectId}::uuid`;
}

interface CoveringRow {
  readonly id: string;
  readonly first: number;
  readonly last: number;
}

/** The rows covering n, by content hash (a multiset: identical objects share a hash). */
async function coveringRows(
  tx: ManifestExecutor,
  scope: MirrorScope,
): Promise<Map<string, CoveringRow[]>> {
  const n = sql`${scope.sequence}::int`;
  const result = await tx.execute(sql`
    SELECT id::text AS id, encode(content_hash, 'hex') AS hash,
           first_sequence AS first, last_sequence AS last
    FROM manifest_versions
    WHERE ${objectFilter(scope)} AND last_sequence >= ${n} AND first_sequence <= ${n}
  `);
  const byHash = new Map<string, CoveringRow[]>();
  for (const row of rowsOf<{ id: string; hash: string; first: number; last: number }>(result)) {
    const list = byHash.get(row.hash) ?? [];
    list.push({ id: row.id, first: Number(row.first), last: Number(row.last) });
    byHash.set(row.hash, list);
  }
  return byHash;
}

/**
 * Identical rows that ended just before n (at or after the previous completed
 * snapshot), one per object: the newest first.
 */
async function extensionCandidates(
  tx: ManifestExecutor,
  scope: MirrorScope,
  previous: number | null,
  entries: readonly StoredEntry[],
): Promise<Map<string, string[]>> {
  const paths = [...new Set(entries.map((entry) => entry.path))];
  const result = await tx.execute(sql`
    SELECT id::text AS id, encode(content_hash, 'hex') AS hash
    FROM manifest_versions
    WHERE ${objectFilter(scope)}
      AND path IN (${sql.join(
        paths.map((path) => sql`${path}::text`),
        sql`, `,
      )})
      AND last_sequence < ${scope.sequence}::int AND last_sequence >= ${previous ?? 0}::int
    ORDER BY last_sequence DESC, id
  `);
  const byHash = new Map<string, string[]>();
  for (const row of rowsOf<{ id: string; hash: string }>(result)) {
    byHash.set(row.hash, [...(byHash.get(row.hash) ?? []), row.id]);
  }
  return byHash;
}

async function insertVersions(
  tx: ManifestExecutor,
  scope: MirrorScope,
  last: number,
  entries: readonly StoredEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const rows = entries.map(
    (entry) => sql`(${scope.tenantId}::uuid, ${scope.protectedObjectId}::uuid,
      ${scope.sequence}::int, ${last}::int, ${Buffer.from(entry.hash, "hex")}::bytea,
      ${entry.kind}::manifest_object_kind, ${entry.path}::text, ${entry.name}::text,
      ${entry.parentPath}::text, ${entry.size}::bigint,
      ${entry.mtime ? entry.mtime.toISOString() : null}::timestamptz,
      ${entry.itemId}::text, ${entry.messageId}::text,
      ${entry.chunkRefs ? chunkIdArrayLiteral(entry.chunkRefs) : null}::bytea[],
      ${entry.metadata === null ? null : JSON.stringify(entry.metadata)}::jsonb,
      ${entry.deleted}::boolean)`,
  );
  await tx.execute(sql`
    INSERT INTO manifest_versions (tenant_id, protected_object_id, first_sequence, last_sequence,
      content_hash, kind, path, name, parent_path, size, mtime, item_id, message_id, chunk_refs,
      metadata, deleted)
    VALUES ${sql.join(rows, sql`, `)}
  `);
}

/**
 * Covering rows no object of the snapshot matched stop covering n. The part
 * after n is kept (as its own row) only where a completed snapshot still
 * needs it; anything beyond n covers no completed snapshot otherwise.
 */
async function closeAt(
  tx: ManifestExecutor,
  scope: MirrorScope,
  next: number | null,
  ids: readonly string[],
): Promise<void> {
  const n = sql`${scope.sequence}::int`;
  const q = sql`${next}::int`;
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = uuidArray(ids.slice(i, i + ID_BATCH));
    const keepsAfter = sql`(last_sequence > ${n} AND ${q} IS NOT NULL AND last_sequence >= ${q})`;
    const target = sql`${objectFilter(scope)} AND id = ANY(${batch})`;
    await tx.execute(sql`
      INSERT INTO manifest_versions (tenant_id, protected_object_id, first_sequence, last_sequence,
        content_hash, kind, path, name, parent_path, size, mtime, item_id, message_id, chunk_refs,
        metadata, deleted)
      SELECT tenant_id, protected_object_id, ${n} + 1, last_sequence,
        content_hash, kind, path, name, parent_path, size, mtime, item_id, message_id, chunk_refs,
        metadata, deleted
      FROM manifest_versions
      WHERE ${target} AND first_sequence < ${n} AND ${keepsAfter}
    `);
    await tx.execute(sql`
      UPDATE manifest_versions SET first_sequence = ${n} + 1
      WHERE ${target} AND first_sequence = ${n} AND ${keepsAfter}
    `);
    await tx.execute(sql`
      DELETE FROM manifest_versions WHERE ${target} AND first_sequence = ${n}
    `);
    await tx.execute(sql`
      UPDATE manifest_versions SET last_sequence = ${n} - 1
      WHERE ${target} AND first_sequence < ${n}
    `);
  }
}

/**
 * Merge rows that end at n with identical rows starting after n, up to the
 * next completed snapshot. Only sequences between n and that snapshot become
 * newly covered, and no completed snapshot lies there.
 */
async function mergeForward(
  tx: ManifestExecutor,
  scope: MirrorScope,
  next: number,
): Promise<number> {
  const n = sql`${scope.sequence}::int`;
  const result = await tx.execute(sql`
    WITH lower AS (
      SELECT v.id, v.content_hash, v.path,
             row_number() OVER (PARTITION BY v.content_hash ORDER BY v.id) AS occ
      FROM manifest_versions v
      WHERE ${objectFilter(scope, "v")} AND v.first_sequence <= ${n} AND v.last_sequence = ${n}
    ),
    upper AS (
      SELECT v.id, v.content_hash, v.path, v.last_sequence,
             row_number() OVER (PARTITION BY v.content_hash ORDER BY v.first_sequence, v.id) AS occ
      FROM manifest_versions v
      WHERE ${objectFilter(scope, "v")} AND v.first_sequence > ${n}
        AND v.first_sequence <= ${next}::int
    ),
    pairs AS (
      SELECT l.id AS lower_id, u.id AS upper_id, u.last_sequence
      FROM lower l
      JOIN upper u ON u.content_hash = l.content_hash AND u.path = l.path AND u.occ = l.occ
    ),
    dropped AS (
      DELETE FROM manifest_versions v USING pairs p WHERE v.id = p.upper_id
      RETURNING 1
    ),
    merged AS (
      UPDATE manifest_versions v SET last_sequence = p.last_sequence
      FROM pairs p WHERE v.id = p.lower_id
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM merged)::int AS merged, (SELECT count(*) FROM dropped)::int AS dropped
  `);
  return Number(rowsOf<{ merged: number }>(result)[0]?.merged ?? 0);
}

type EntryBatches =
  | AsyncIterable<readonly ManifestMirrorEntry[]>
  | Iterable<readonly ManifestMirrorEntry[]>;

function inBatches(entries: readonly ManifestMirrorEntry[]): ManifestMirrorEntry[][] {
  const batches: ManifestMirrorEntry[][] = [];
  for (let i = 0; i < entries.length; i += WRITE_BATCH) {
    batches.push(entries.slice(i, i + WRITE_BATCH));
  }
  return batches;
}

/** The diff described in the module comment, for one snapshot's objects in batches. */
async function foldSnapshot(
  tx: ManifestExecutor,
  scope: MirrorScope,
  batches: EntryBatches,
): Promise<MirrorOutcome> {
  await lockObject(tx, scope.protectedObjectId);
  const previous = await previousCompleted(tx, scope);
  const next = await nextCompleted(tx, scope);
  // The newest completed snapshot keeps its versions open; an older one ends them at n.
  const last = next === null ? OPEN_SEQUENCE : scope.sequence;
  const covering = await coveringRows(tx, scope);
  let unchanged = 0;
  let extended = 0;
  let inserted = 0;
  for await (const raw of batches) {
    for (let i = 0; i < raw.length; i += WRITE_BATCH) {
      const unmatched: StoredEntry[] = [];
      for (const entry of raw.slice(i, i + WRITE_BATCH).map(storedEntry)) {
        const rows = covering.get(entry.hash);
        if (rows && rows.length > 0) {
          rows.pop();
          unchanged += 1;
        } else {
          unmatched.push(entry);
        }
      }
      if (unmatched.length === 0) {
        continue;
      }
      const candidates = await extensionCandidates(tx, scope, previous, unmatched);
      const extend: string[] = [];
      const fresh: StoredEntry[] = [];
      for (const entry of unmatched) {
        const id = candidates.get(entry.hash)?.shift();
        if (id) {
          extend.push(id);
        } else {
          fresh.push(entry);
        }
      }
      if (extend.length > 0) {
        await tx.execute(sql`
          UPDATE manifest_versions SET last_sequence = ${last}::int
          WHERE ${objectFilter(scope)} AND id = ANY(${uuidArray(extend)})
        `);
      }
      await insertVersions(tx, scope, last, fresh);
      extended += extend.length;
      inserted += fresh.length;
    }
  }
  const stale = [...covering.values()].flatMap((rows) => rows.map((row) => row.id));
  await closeAt(tx, scope, next, stale);
  const merged = next === null ? 0 : await mergeForward(tx, scope, next);
  return { unchanged, extended, inserted, removed: stale.length, merged };
}

/**
 * Mirror one snapshot's objects into the index (idempotent per snapshot: a
 * retried commit replaces what an earlier attempt wrote). `entries` is the
 * whole object list, or batches of it. Removes the old per-snapshot rows of
 * the same snapshot, should a 0.3.4 attempt have left any.
 */
export async function recordManifestVersions(
  tx: ManifestExecutor,
  scope: MirrorScope,
  entries: readonly ManifestMirrorEntry[] | EntryBatches,
): Promise<MirrorOutcome> {
  await lockObject(tx, scope.protectedObjectId);
  await tx.execute(sql`
    DELETE FROM manifest_objects
    WHERE tenant_id = ${scope.tenantId}::uuid AND snapshot_id = ${scope.snapshotId}::uuid
  `);
  const batches = Array.isArray(entries)
    ? inBatches(entries as readonly ManifestMirrorEntry[])
    : (entries as EntryBatches);
  return foldSnapshot(tx, scope, batches);
}

/** Old chunk ids (jsonb hex strings) as `bytea[]`, by the same rule as `chunkIdBytes`. */
const LEGACY_CHUNKS = sql.raw(`CASE WHEN jsonb_typeof(l.chunk_refs) = 'array' THEN ARRAY(
    SELECT CASE WHEN e.id ~ '^([0-9a-fA-F]{2})*$' THEN decode(e.id, 'hex') ELSE convert_to(e.id, 'UTF8') END
    FROM jsonb_array_elements_text(l.chunk_refs) WITH ORDINALITY AS e(id, ord) ORDER BY e.ord
  ) END`);

/** Old metadata as the index keeps it ({@link mirrorMetadata} in SQL). */
const LEGACY_METADATA = sql`CASE WHEN jsonb_typeof(l.metadata) = 'object'
  THEN l.metadata - ${OMITTED_KEYS_SQL} ELSE l.metadata END`;

export interface ConversionOutcome extends MirrorOutcome {
  /** Old per-snapshot rows folded in (and deleted). */
  readonly converted: number;
}

interface LegacyRow extends Record<string, unknown> {
  id: string;
  kind: ManifestObjectKind;
  path: string;
  name: string;
  parent_path: string;
  size: string | number;
  mtime: Date | string | null;
  item_id: string | null;
  message_id: string | null;
  chunk_refs: unknown;
  metadata: unknown;
  deleted: boolean;
}

function legacyEntry(row: LegacyRow): ManifestMirrorEntry {
  const mtime = row.mtime === null ? null : new Date(row.mtime);
  return {
    kind: row.kind,
    path: row.path,
    name: row.name,
    parentPath: row.parent_path,
    size: Number(row.size),
    mtime,
    itemId: row.item_id,
    messageId: row.message_id,
    chunkRefs: Array.isArray(row.chunk_refs) ? row.chunk_refs.map((id) => String(id)) : null,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    deleted: row.deleted,
  };
}

/** The old rows of one snapshot, page by page (keyset on the per-snapshot index). */
async function* legacyPages(
  tx: ManifestExecutor,
  tenantId: string,
  snapshotId: string,
  counter: { rows: number },
): AsyncGenerator<ManifestMirrorEntry[]> {
  let after: { parentPath: string; id: string } | null = null;
  for (;;) {
    const result = await tx.execute(sql`
      SELECT id::text AS id, kind, path, name, parent_path, size, mtime, item_id, message_id,
             chunk_refs, metadata, deleted
      FROM manifest_objects
      WHERE tenant_id = ${tenantId}::uuid AND snapshot_id = ${snapshotId}::uuid
        ${after ? sql`AND (parent_path, id) > (${after.parentPath}::text, ${after.id}::uuid)` : sql``}
      ORDER BY parent_path, id
      LIMIT ${CONVERT_PAGE}
    `);
    const rows = rowsOf<LegacyRow>(result);
    if (rows.length === 0) {
      return;
    }
    counter.rows += rows.length;
    yield rows.map(legacyEntry);
    const tail = rows[rows.length - 1] as LegacyRow;
    after = { parentPath: tail.parent_path, id: tail.id };
  }
}

/**
 * Fold the old per-snapshot rows of one snapshot into the versions and delete
 * them, in the caller's transaction (atomic: readers see either the old rows
 * or the versions, never both or neither). Returns null when the snapshot has
 * no old rows (any more). Only a completed active snapshot is folded in; the
 * old rows of a pruned or never completed one are just deleted. Convert the
 * snapshots of an object oldest first: that is what lets unchanged objects
 * stay one row.
 */
export async function convertLegacySnapshot(
  tx: ManifestExecutor,
  tenantId: string,
  snapshotId: string,
): Promise<ConversionOutcome | null> {
  const found = await tx.execute(sql`
    SELECT protected_object_id::text AS protected_object_id, sequence,
           (status = 'active' AND manifest_path IS NOT NULL) AS completed
    FROM snapshots
    WHERE tenant_id = ${tenantId}::uuid AND id = ${snapshotId}::uuid
  `);
  const snapshot = rowsOf<{ protected_object_id: string; sequence: number; completed: boolean }>(
    found,
  )[0];
  if (!snapshot) {
    return null;
  }
  const scope: MirrorScope = {
    tenantId,
    protectedObjectId: snapshot.protected_object_id,
    snapshotId,
    sequence: Number(snapshot.sequence),
  };
  await lockObject(tx, scope.protectedObjectId);
  const any = await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM manifest_objects
      WHERE tenant_id = ${tenantId}::uuid AND snapshot_id = ${snapshotId}::uuid
    ) AS present
  `);
  if (rowsOf<{ present: boolean }>(any)[0]?.present !== true) {
    return null;
  }
  if (!snapshot.completed) {
    // Pruned (nothing reads it) or never completed (a commit that completes it mirrors
    // it again): its old rows only go.
    const dropped = await tx.execute(sql`
      DELETE FROM manifest_objects
      WHERE tenant_id = ${tenantId}::uuid AND snapshot_id = ${snapshotId}::uuid
      RETURNING 1
    `);
    return {
      unchanged: 0,
      extended: 0,
      inserted: 0,
      removed: 0,
      merged: 0,
      converted: rowsOf(dropped).length,
    };
  }
  const counter = { rows: 0 };
  const outcome = await foldSnapshot(tx, scope, legacyPages(tx, tenantId, snapshotId, counter));
  await tx.execute(sql`
    DELETE FROM manifest_objects
    WHERE tenant_id = ${tenantId}::uuid AND snapshot_id = ${snapshotId}::uuid
  `);
  return { ...outcome, converted: counter.rows };
}

/**
 * A snapshot left the index (pruned, or discarded before it completed):
 * delete the version rows that covered it and no longer cover any active
 * snapshot, and its old per-snapshot rows. Rows that still cover another
 * active snapshot stay as they are. Returns how many rows were deleted.
 */
export async function releaseManifestSnapshot(
  tx: ManifestExecutor,
  scope: MirrorScope,
): Promise<number> {
  await lockObject(tx, scope.protectedObjectId);
  const n = sql`${scope.sequence}::int`;
  const versions = await tx.execute(sql`
    DELETE FROM manifest_versions v
    WHERE v.tenant_id = ${scope.tenantId}::uuid
      AND v.protected_object_id = ${scope.protectedObjectId}::uuid
      AND v.first_sequence <= ${n} AND v.last_sequence >= ${n}
      AND NOT EXISTS (
        SELECT 1 FROM snapshots s
        WHERE s.tenant_id = v.tenant_id AND s.protected_object_id = v.protected_object_id
          AND s.status = 'active' AND s.id <> ${scope.snapshotId}::uuid
          AND s.sequence BETWEEN v.first_sequence AND v.last_sequence
      )
    RETURNING 1
  `);
  const legacy = await tx.execute(sql`
    DELETE FROM manifest_objects
    WHERE tenant_id = ${scope.tenantId}::uuid AND snapshot_id = ${scope.snapshotId}::uuid
    RETURNING 1
  `);
  return rowsOf(versions).length + rowsOf(legacy).length;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ManifestEntriesOptions {
  readonly tenantId: string;
  /**
   * Which snapshots, as a condition on `snapshots` aliased `s` (for example
   * `s.id = ANY(...)`, or every completed snapshot of one object).
   */
  readonly snapshots: SQL;
  /** Include `chunk_refs` (as `bytea[]`); only content reads need it. */
  readonly chunks?: boolean;
}

/**
 * The entries of the selected snapshots, one row per object per snapshot,
 * exactly as the per-snapshot mirror of 0.3.4 had them: a parenthesised
 * subquery to use as `FROM ${manifestEntries(...)} AS m`. Columns: `id` (the
 * version row id, stable across the snapshots it covers), `snapshot_id`,
 * `snapshot_sequence`, `snapshot_completed_at`, `tenant_id`,
 * `protected_object_id`, `kind`, `path`, `name`, `parent_path`, `size`,
 * `mtime`, `item_id`, `message_id`, `metadata`, `deleted` and, with
 * `chunks`, `chunk_refs`. A snapshot not yet converted from the old mirror is
 * read from its old rows (and only from those), so the result is complete
 * and exact while the conversion runs.
 */
export function manifestEntries(options: ManifestEntriesOptions): SQL {
  const versionChunks = options.chunks ? sql`, v.chunk_refs` : sql``;
  const legacyChunks = options.chunks ? sql`, ${LEGACY_CHUNKS} AS chunk_refs` : sql``;
  return sql`(
    SELECT v.id, s.id AS snapshot_id, s.sequence AS snapshot_sequence,
           s.completed_at AS snapshot_completed_at, v.tenant_id, v.protected_object_id,
           v.kind, v.path, v.name, v.parent_path, v.size, v.mtime, v.item_id, v.message_id,
           v.metadata, v.deleted${versionChunks}
    FROM snapshots s
    JOIN manifest_versions v
      ON v.tenant_id = s.tenant_id AND v.protected_object_id = s.protected_object_id
     AND v.first_sequence <= s.sequence AND v.last_sequence >= s.sequence
    WHERE s.tenant_id = ${options.tenantId}::uuid AND (${options.snapshots})
      AND NOT EXISTS (SELECT 1 FROM manifest_objects legacy WHERE legacy.snapshot_id = s.id)
    UNION ALL
    SELECT l.id, s.id AS snapshot_id, s.sequence AS snapshot_sequence,
           s.completed_at AS snapshot_completed_at, l.tenant_id, l.protected_object_id,
           l.kind, l.path, l.name, l.parent_path, l.size, l.mtime, l.item_id, l.message_id,
           ${LEGACY_METADATA} AS metadata, l.deleted${legacyChunks}
    FROM snapshots s
    JOIN manifest_objects l ON l.tenant_id = s.tenant_id AND l.snapshot_id = s.id
    WHERE s.tenant_id = ${options.tenantId}::uuid AND (${options.snapshots})
  )`;
}

/**
 * Protected objects whose active snapshots reference any of the given chunk
 * ids (hex), old per-snapshot rows included. A scan of the tenant's index:
 * meant for rare work such as the scrub's report on packs damaged beyond
 * repair.
 */
export async function objectsReferencingChunks(
  tx: ManifestExecutor,
  tenantId: string,
  chunkIds: readonly string[],
): Promise<string[]> {
  if (chunkIds.length === 0) {
    return [];
  }
  const hexIds = sql.join(
    chunkIds.map((id) => sql`${id}::text`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    SELECT v.protected_object_id::text AS id FROM manifest_versions v
    WHERE v.tenant_id = ${tenantId}::uuid
      AND v.chunk_refs && ${chunkIdArrayLiteral(chunkIds)}::bytea[]
      AND EXISTS (
        SELECT 1 FROM snapshots s
        WHERE s.tenant_id = v.tenant_id AND s.protected_object_id = v.protected_object_id
          AND s.status = 'active' AND s.sequence BETWEEN v.first_sequence AND v.last_sequence
      )
    UNION
    SELECT l.protected_object_id::text AS id FROM manifest_objects l
    JOIN snapshots s ON s.id = l.snapshot_id
    WHERE l.tenant_id = ${tenantId}::uuid AND s.status = 'active'
      AND l.chunk_refs ?| ARRAY[${hexIds}]::text[]
  `);
  return rowsOf<{ id: string }>(result).map((row) => row.id);
}
