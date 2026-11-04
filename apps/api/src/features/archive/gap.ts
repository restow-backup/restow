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
 */
import { archiveItemOfMailbox, archiveItems, protectedObjects, snapshots, users } from "@restow/db";
import { and, desc, eq, gte, isNotNull, ne, type SQL, sql } from "drizzle-orm";
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

export interface ArchiveGapDto {
  objectId: string;
  /** Start of the newest completed backup the gap is measured from; null without a backup. */
  since: string | null;
  /** That backup; null without one. */
  snapshotId: string | null;
  items: ArchiveSearchResultDto[];
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

/** The newest completed backup of the object, as the start of the gap. */
async function newestBackup(
  tx: DbExecutor,
  tenantId: string,
  objectId: string,
): Promise<{ id: string; since: Date } | null> {
  const [row] = await tx
    .select({
      id: snapshots.id,
      since: sql<Date>`coalesce(${snapshots.startedAt}, ${snapshots.completedAt}, ${snapshots.createdAt})`,
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
  return { id: row.id, since: new Date(row.since) };
}

/** The `where` of the gap: the mailbox's items after `since` that arrived on their own. */
export function archiveGapConditions(
  tenantId: string,
  objectId: string,
  since: Date | null,
): SQL[] {
  return [
    eq(archiveItems.tenantId, tenantId),
    archiveItemOfMailbox(objectId),
    ne(archiveItems.capturedVia, "file_import"),
    sql`not coalesce(${archiveItems.flags}, '[]'::jsonb) @> '["captured-late"]'::jsonb`,
    sql`not ${isSuperseded}`,
    ...(since ? [gte(archiveItems.receivedAt, since)] : []),
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
      .select(archiveResultColumns)
      .from(archiveItems)
      .where(where)
      .orderBy(desc(archiveItems.receivedAt), desc(archiveItems.id))
      .limit(query.limit)
      .offset(query.offset);

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
        total: count,
      },
    });

    return {
      objectId: object.id,
      since: backup ? backup.since.toISOString() : null,
      snapshotId: backup?.id ?? null,
      items: rows.map(toResultDto),
      total: count,
      limit: query.limit,
      offset: query.offset,
    };
  });
}
