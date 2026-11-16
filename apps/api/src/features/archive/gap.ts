/**
 * "Aus dem Archiv" in the restore explorer (docs/ARCHIVE.md "Aus dem Archiv im
 * Restore-Explorer", #48): the archived mail of one mailbox or IMAP account that
 * arrived after its newest backup, the gap between two backups the archive
 * already holds.
 *
 * Read only and with the archive's own rules: only tenant administrators (the
 * route's guard, like every archive route), every listing audited as an
 * archive search (`archive.searched`, `details.view = "restore_gap"`), and on
 * whose behalf it was read when the mailbox is not the reader's own. Opening,
 * downloading and restoring a message go through the archive's audited reads
 * and the restore request (features/restore/archive.ts).
 *
 * Which items count: those of the mailbox (its own captures and the journal
 * reports assigned to it, `archiveItemOfMailbox`) captured at or after the
 * start of the newest completed backup, so a mail that arrived while that
 * backup ran shows rather than slips through. Left out: captures a stronger
 * capture of the same mail superseded (as in the search), imported mail files
 * and the one-time takeover (`captured-late`): neither arrived after the backup,
 * the backup already holds what was in the mailbox. Without any backup every
 * such item of the mailbox counts.
 *
 * Capture time, not the mail's own date, sets the boundary: a mail a capture took in
 * shortly after the backup began although it arrived just before it is listed rather than
 * missed (a mail's Date header says when it was written, not when it was delivered). Such a
 * mail may already be in the backup; every listed item is therefore checked against the
 * newest backup's index by its Message-ID (`inBackup`), and the explorer says so. Only the
 * page's items written before that backup completed are checked: a later one cannot be in it.
 * The lookup matches the Message-ID as the headers spell it (`messageIdSpellings`), through
 * `manifest_versions_object_message_idx`.
 *
 * Read through indexes only (migration 0075): the mailbox's own captures as an index range
 * from the start of the backup on, its assigned items through their assignments
 * (`archiveItemIdsOfMailbox`), never a scan of the tenant's archive.
 */
import { archive } from "@restow/core";
import {
  archiveItemIdsOfMailbox,
  archiveItems,
  manifestVersions,
  protectedObjects,
  snapshots,
  users,
} from "@restow/db";
import { and, desc, eq, gte, isNotNull, lte, ne, type SQL, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { onBehalfOfOwner } from "../snapshots/access.js";
import type { ArchiveGapQuery } from "./schemas.js";
import {
  type ArchiveActor,
  type ArchiveSearchResultDto,
  archiveResultColumns,
  isSuperseded,
  toResultDto,
} from "./service.js";

/** The kinds of protected objects whose mail the archive holds. */
export const ARCHIVE_MAIL_KINDS = ["mailbox", "imap"] as const;

/** One listed message: a search result, and whether the newest backup holds it already. */
export interface ArchiveGapItemDto extends ArchiveSearchResultDto {
  /**
   * The newest backup holds a mail with the same Message-ID: it reached the archive after the
   * backup began but was in the mailbox before. Putting it back makes a second copy.
   */
  inBackup: boolean;
}

export interface ArchiveGapDto {
  objectId: string;
  /** Start of the newest completed backup the gap is measured from; null without a backup. */
  since: string | null;
  /** That backup; null without one. */
  snapshotId: string | null;
  items: ArchiveGapItemDto[];
  total: number;
  limit: number;
  offset: number;
}

/** A reader of the gap: who they are, for the audit and the `onBehalfOf` of another person's mail. */
export interface ArchiveGapActor extends ArchiveActor {
  email: string;
}

/** The mailbox or IMAP account of the tenant whose gap is asked for; 404 for anything else. */
export async function loadArchiveMailbox(tx: DbExecutor, tenantId: string, objectId: string) {
  const [row] = await tx
    .select({
      id: protectedObjects.id,
      kind: protectedObjects.kind,
      externalId: protectedObjects.externalId,
      status: protectedObjects.status,
      statusReason: protectedObjects.statusReason,
      sourceId: protectedObjects.sourceId,
      ownerEmail: users.email,
    })
    .from(protectedObjects)
    .leftJoin(users, eq(users.id, protectedObjects.userId))
    .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, objectId)))
    .limit(1);
  if (!row || !(ARCHIVE_MAIL_KINDS as readonly string[]).includes(row.kind)) {
    throw new ProblemError(404, "Mailbox not found", {
      detail: "The archive holds mail of mailboxes and IMAP accounts only.",
    });
  }
  return row;
}

/** The newest completed backup of an object: where its gap begins. */
export interface NewestBackup {
  id: string;
  sequence: number;
  /** When it began: the start of the gap. */
  since: Date;
  /** When it completed: nothing written later can be in it. */
  until: Date;
}

/** The newest completed backup of the object, as the start of the gap. */
export async function newestBackup(
  tx: DbExecutor,
  tenantId: string,
  objectId: string,
): Promise<NewestBackup | null> {
  const [row] = await tx
    .select({
      id: snapshots.id,
      sequence: snapshots.sequence,
      since: sql<Date>`coalesce(${snapshots.startedAt}, ${snapshots.completedAt}, ${snapshots.createdAt})`,
      until: sql<Date>`coalesce(${snapshots.completedAt}, now())`,
    })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.tenantId, tenantId),
        eq(snapshots.protectedObjectId, objectId),
        eq(snapshots.status, "active"),
        isNotNull(snapshots.manifestPath),
      ),
    )
    .orderBy(desc(snapshots.sequence))
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    sequence: row.sequence,
    since: new Date(row.since),
    until: new Date(row.until),
  };
}

/**
 * The spellings a backup may hold a Message-ID in: as the archive has it and with or without
 * its angle brackets, each also in lowercase. The backup engines store the header as the
 * source gives it, the same header the capture read, so this finds the same mail without an
 * expression over the backup's rows (which no index could serve under row-level security).
 */
export function messageIdSpellings(messageIds: readonly string[]): string[] {
  const spellings = new Set<string>();
  for (const messageId of messageIds) {
    const bare = messageId.replace(/^[<>\s]+|[<>\s]+$/gu, "");
    if (bare.length === 0) {
      continue;
    }
    for (const value of [bare, bare.toLowerCase()]) {
      spellings.add(value);
      spellings.add(`<${value}>`);
    }
    spellings.add(messageId);
  }
  return [...spellings];
}

/**
 * The `where` of the lookup in the backup: its mail (the manifest index, deleted ones
 * included: the backup can restore those too) with one of these Message-ID spellings. An
 * index condition on `manifest_versions_object_message_idx` (migration 0075), not a read of
 * every mail of the mailbox.
 */
export function backupMessageConditions(
  tenantId: string,
  objectId: string,
  sequence: number,
  spellings: readonly string[],
): SQL[] {
  return [
    eq(manifestVersions.tenantId, tenantId),
    eq(manifestVersions.protectedObjectId, objectId),
    sql`${manifestVersions.messageId} = any(${sql.param(spellings)}::text[])`,
    lte(manifestVersions.firstSequence, sequence),
    gte(manifestVersions.lastSequence, sequence),
  ];
}

/** The Message-IDs among `candidates` that the backup holds, as `messageKey`s. One lookup for the page. */
async function messageKeysInBackup(
  tx: DbExecutor,
  tenantId: string,
  objectId: string,
  backup: NewestBackup,
  candidates: readonly string[],
): Promise<Set<string>> {
  const spellings = messageIdSpellings(candidates);
  if (spellings.length === 0) {
    return new Set();
  }
  const rows = await tx
    .selectDistinct({ messageId: manifestVersions.messageId })
    .from(manifestVersions)
    .where(and(...backupMessageConditions(tenantId, objectId, backup.sequence, spellings)));
  return new Set(rows.flatMap((row) => archive.messageKey(row.messageId) ?? []));
}

/**
 * What makes a mailbox's item part of the gap, apart from belonging to the mailbox: it
 * arrived on its own (not imported, not the one-time takeover, not superseded by a stronger
 * capture) at or after `since`. The restore from the archive takes these items only.
 */
export function arrivedAfterBackup(since: Date | null): SQL[] {
  return [
    ne(archiveItems.capturedVia, "file_import"),
    sql`not coalesce(${archiveItems.flags}, '[]'::jsonb) @> '["captured-late"]'::jsonb`,
    sql`not ${isSuperseded}`,
    ...(since ? [gte(archiveItems.receivedAt, since)] : []),
  ];
}

/** The `where` of the gap: the mailbox's items after `since` that arrived on their own. */
export function archiveGapConditions(
  tenantId: string,
  objectId: string,
  since: Date | null,
): SQL[] {
  return [
    eq(archiveItems.tenantId, tenantId),
    archiveItemIdsOfMailbox(tenantId, objectId, since),
    ...arrivedAfterBackup(since),
  ];
}

/** GET /archive/gap: the archived mail of a mailbox after its newest backup (audited). */
export async function listArchiveGap(
  db: DbExecutor,
  tenantId: string,
  query: ArchiveGapQuery,
  actor: ArchiveGapActor,
): Promise<ArchiveGapDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const object = await loadArchiveMailbox(tx, tenantId, query.object);
    const backup = await newestBackup(tx, tenantId, object.id);
    const where = and(...archiveGapConditions(tenantId, object.id, backup?.since ?? null));

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(archiveItems)
      .where(where);
    const rows = await tx
      .select({ ...archiveResultColumns, messageId: archiveItems.messageId })
      .from(archiveItems)
      .where(where)
      .orderBy(desc(archiveItems.receivedAt), desc(archiveItems.id))
      .limit(query.limit)
      .offset(query.offset);
    // Only mail written before the backup completed can be in it (sentAt unknown: check).
    const inBackup = backup
      ? await messageKeysInBackup(
          tx,
          tenantId,
          object.id,
          backup,
          rows
            .filter((row) => row.sentAt === null || row.sentAt.getTime() <= backup.until.getTime())
            .map((row) => row.messageId),
        )
      : new Set<string>();
    const items = rows.map(({ messageId, ...row }) => ({
      ...toResultDto(row),
      inBackup: inBackup.has(archive.messageKey(messageId) ?? ""),
    }));

    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: "archive.searched",
      target: object.id,
      targetType: "protected_object",
      onBehalfOf: onBehalfOfOwner(
        { email: actor.email },
        { externalId: object.externalId, ownerEmail: object.ownerEmail },
      ),
      ip: actor.ip,
      details: {
        view: "restore_gap",
        mailbox: object.id,
        since: backup ? backup.since.toISOString() : null,
        snapshotId: backup?.id ?? null,
        offset: query.offset,
        results: rows.length,
        inBackup: items.filter((item) => item.inBackup).length,
        total: count,
      },
    });

    return {
      objectId: object.id,
      since: backup ? backup.since.toISOString() : null,
      snapshotId: backup?.id ?? null,
      items,
      total: count,
      limit: query.limit,
      offset: query.offset,
    };
  });
}
