/**
 * Archive search, reading and chain verification (docs/ARCHIVE.md), part of
 * the core. Legal holds and the rest of the GoBD layer are modules under
 * `ee/api` (ee/README.md). Every search and every read of archived content
 * is audited (docs/ARCHIVE.md).
 */
import { archive } from "@restow/core";
import {
  type ArchiveEnvelope,
  archiveAnchor,
  archiveItemOfMailbox,
  archiveItems,
} from "@restow/db";
import { type SQL, and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import {
  PreviewBusyError,
  PreviewUnreadableError,
  previewInWorker,
} from "../snapshots/preview-isolated.js";
import {
  type MailPreviewDto,
  PREVIEW_SIZE_CAP_BYTES,
  type PreviewHeaders,
} from "../snapshots/preview.js";
import { PgArchiveCatalog } from "./catalog.js";
import { ArchiveContentError, emlFileName, readArchiveItemBytes } from "./content.js";
import type { ArchiveSearchQuery } from "./schemas.js";

export interface ArchiveActor {
  userId: string | null;
  label: string;
  ip: string | null;
}

export interface ArchiveSearchResultDto {
  id: string;
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  receivedAt: string;
  /** The message's own date (Date header) when the capture path knew it; null otherwise. */
  sentAt: string | null;
  hasAttachment: boolean;
  sizeBytes: number | null;
  flags: string[];
  /** How the item was captured: the journal receiver, a sync, or an imported mail file. */
  source: archive.ArchiveSource;
}

export interface ArchiveSearchResponse {
  items: ArchiveSearchResultDto[];
  total: number;
  limit: number;
  offset: number;
}

function toResultDto(row: {
  id: string;
  subject: string | null;
  envelope: ArchiveEnvelope | null;
  receivedAt: Date;
  sentAt: Date | null;
  hasAttachment: boolean;
  sizeBytes: number | null;
  flags: string[] | null;
  capturedVia: archive.ArchiveSource;
}): ArchiveSearchResultDto {
  return {
    id: row.id,
    subject: row.subject,
    from: row.envelope?.from ?? null,
    to: row.envelope?.to ?? [],
    cc: row.envelope?.cc ?? [],
    receivedAt: row.receivedAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    hasAttachment: row.hasAttachment,
    sizeBytes: row.sizeBytes,
    flags: row.flags ?? [],
    source: row.capturedVia,
  };
}

/**
 * The date a message is filtered and ordered by: its own date (`sent_at`)
 * when the capture path knew it, otherwise the capture time. Imported mail is
 * captured today but was written years ago; retention still counts from
 * `received_at`.
 */
const messageDate = sql`coalesce(${archiveItems.sentAt}, ${archiveItems.receivedAt})`;

/** The search filters that select archive items (also used by export requests). */
export type ArchiveFilter = Pick<
  ArchiveSearchQuery,
  "q" | "mailbox" | "from" | "dateFrom" | "dateTo" | "hasAttachment"
>;

/** The `where` conditions of an archive search, always including the tenant. */
export function archiveSearchConditions(tenantId: string, query: ArchiveFilter): SQL[] {
  const conditions = [eq(archiveItems.tenantId, tenantId)];
  if (query.mailbox) {
    conditions.push(archiveItemOfMailbox(query.mailbox));
  }
  if (query.dateFrom) {
    conditions.push(gte(messageDate, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(messageDate, query.dateTo));
  }
  if (query.hasAttachment !== undefined) {
    conditions.push(eq(archiveItems.hasAttachment, query.hasAttachment));
  }
  if (query.from) {
    conditions.push(sql`${archiveItems.envelope}->>'from' ILIKE ${`%${query.from}%`}`);
  }
  if (query.q && query.q.length > 0) {
    // Must stay in sync with the GIN index expression (packages/db/src/schema/archive.ts,
    // archiveSearchVectorSql / drizzle/0008_ancient_ricochet.sql).
    conditions.push(
      sql`to_tsvector('simple',
          coalesce(${archiveItems.subject}, '') || ' ' ||
          coalesce(${archiveItems.bodyText}, '') || ' ' ||
          coalesce(${archiveItems.envelope}::text, '')
        ) @@ plainto_tsquery('simple', ${query.q})`,
    );
  }
  return conditions;
}

/** Search the tenant's archive; audits the search itself (query, filters, result count). */
export async function searchArchive(
  db: DbExecutor,
  tenantId: string,
  query: ArchiveSearchQuery,
  actor: ArchiveActor,
): Promise<ArchiveSearchResponse> {
  return withTenantTx(db, tenantId, async (tx) => {
    const conditions = archiveSearchConditions(tenantId, query);
    const where = and(...conditions);

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(archiveItems)
      .where(where);

    const rows = await tx
      .select({
        id: archiveItems.id,
        subject: archiveItems.subject,
        envelope: archiveItems.envelope,
        receivedAt: archiveItems.receivedAt,
        sentAt: archiveItems.sentAt,
        hasAttachment: archiveItems.hasAttachment,
        sizeBytes: archiveItems.sizeBytes,
        flags: archiveItems.flags,
        capturedVia: archiveItems.capturedVia,
      })
      .from(archiveItems)
      .where(where)
      .orderBy(desc(messageDate), desc(archiveItems.receivedAt), desc(archiveItems.id))
      .limit(query.limit)
      .offset(query.offset);

    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: "archive.searched",
      target: null,
      targetType: null,
      ip: actor.ip,
      details: {
        q: query.q ?? null,
        mailbox: query.mailbox ?? null,
        from: query.from ?? null,
        dateFrom: query.dateFrom ? query.dateFrom.toISOString() : null,
        dateTo: query.dateTo ? query.dateTo.toISOString() : null,
        hasAttachment: query.hasAttachment ?? null,
        offset: query.offset,
        results: rows.length,
        total: count,
      },
    });

    return { items: rows.map(toResultDto), total: count, limit: query.limit, offset: query.offset };
  });
}

/** An archived item as the API returns it: the catalog record plus the message's own date. */
export type ArchiveItemDto = archive.ArchiveItemRecord & {
  /** The message's own date (Date header) when the capture path knew it; null otherwise. */
  sentAt: string | null;
};

/** One archived item's metadata (never the decrypted body — see features/archive/routes.ts for the preview endpoint). */
export async function getArchiveItem(
  db: DbExecutor,
  tenantId: string,
  itemId: string,
  actor: ArchiveActor,
): Promise<ArchiveItemDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const catalog = new PgArchiveCatalog({
      db: tx,
      storagePathOf: (record) =>
        archive.archiveItemKey(record.tenantId, record.receivedAt, record.id),
    });
    const record = await catalog.get(tenantId, itemId);
    if (!record) {
      throw new ProblemError(404, "Archive item not found");
    }
    const [dates] = await tx
      .select({ sentAt: archiveItems.sentAt })
      .from(archiveItems)
      .where(eq(archiveItems.id, itemId))
      .limit(1);
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: "archive.item.read",
      target: itemId,
      targetType: "archive_item",
      ip: actor.ip,
      details: null,
    });
    return { ...record, sentAt: dates?.sentAt ? dates.sentAt.toISOString() : null };
  });
}

/** The `archive_items` fields the reading pane and the download need. */
async function loadContentRow(tx: DbExecutor, tenantId: string, itemId: string) {
  const [row] = await tx
    .select({
      id: archiveItems.id,
      itemHash: archiveItems.itemHash,
      sizeBytes: archiveItems.sizeBytes,
      chunks: archiveItems.chunks,
      receivedAt: archiveItems.receivedAt,
      sentAt: archiveItems.sentAt,
      subject: archiveItems.subject,
      messageId: archiveItems.messageId,
      envelope: archiveItems.envelope,
    })
    .from(archiveItems)
    .where(and(eq(archiveItems.tenantId, tenantId), eq(archiveItems.id, itemId)))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Archive item not found");
  }
  return row;
}

type ContentRow = Awaited<ReturnType<typeof loadContentRow>>;

/** Headers from the catalog row alone, for a message that is not opened. */
function headersOfRow(row: ContentRow): PreviewHeaders {
  return {
    subject: row.subject,
    from: row.envelope?.from ?? null,
    to: row.envelope?.to ?? [],
    cc: row.envelope?.cc ?? [],
    date: (row.sentAt ?? row.receivedAt).toISOString(),
    messageId: row.messageId,
  };
}

function archiveContentProblem(error: unknown): ProblemError {
  const problem = error instanceof ArchiveContentError ? error.problem : "unreadable";
  return new ProblemError(problem === "not_recorded" ? 404 : 502, "Archived content not readable", {
    type: "urn:restow:problem:archive-content-unavailable",
    detail:
      problem === "mismatch"
        ? "The stored message does not match the SHA-256 recorded when it was archived."
        : problem === "not_recorded"
          ? "This item was archived before its content reference was recorded; it can only be exported."
          : "The message could not be read from the repository.",
    extensions: { problem },
  });
}

/**
 * The reading pane of one archived message: a sanitised view parsed in an
 * isolated process (snapshots/preview-isolated.ts), from the original bytes
 * verified against their recorded SHA-256. Audited as a read of archived content.
 */
export async function previewArchiveItem(
  db: DbExecutor,
  tenantId: string,
  itemId: string,
  actor: ArchiveActor,
): Promise<MailPreviewDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const row = await loadContentRow(tx, tenantId, itemId);
    let preview: MailPreviewDto;
    if ((row.sizeBytes ?? 0) > PREVIEW_SIZE_CAP_BYTES) {
      preview = {
        previewable: false,
        reason: "too-large",
        headers: headersOfRow(row),
        attachments: [],
      };
    } else {
      let bytes: Buffer;
      try {
        bytes = await readArchiveItemBytes(tx, tenantId, row);
      } catch (error) {
        throw archiveContentProblem(error);
      }
      try {
        preview = await previewInWorker(bytes);
      } catch (error) {
        if (error instanceof PreviewUnreadableError) {
          preview = {
            previewable: false,
            reason: "unreadable",
            headers: headersOfRow(row),
            attachments: [],
          };
        } else if (error instanceof PreviewBusyError) {
          throw new ProblemError(503, "Preview busy", {
            type: "urn:restow:problem:preview-busy",
            detail:
              "Many messages are being prepared for display at the moment. Try again in a few seconds.",
            extensions: { retryable: true },
          });
        } else {
          throw error;
        }
      }
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: "archive.item.previewed",
      target: itemId,
      targetType: "archive_item",
      ip: actor.ip,
      details: { previewable: preview.previewable },
    });
    return preview;
  });
}

export interface ArchiveDownloadDto {
  fileName: string;
  content: Buffer;
}

/** The original message as archived, byte for byte (verified), for a `.eml` download. Audited. */
export async function downloadArchiveItem(
  db: DbExecutor,
  tenantId: string,
  itemId: string,
  actor: ArchiveActor,
): Promise<ArchiveDownloadDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const row = await loadContentRow(tx, tenantId, itemId);
    let content: Buffer;
    try {
      content = await readArchiveItemBytes(tx, tenantId, row);
    } catch (error) {
      throw archiveContentProblem(error);
    }
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: "archive.item.downloaded",
      target: itemId,
      targetType: "archive_item",
      ip: actor.ip,
      details: { bytes: content.length },
    });
    return { fileName: emlFileName(row.subject, itemId), content };
  });
}

/** Read-side helper for the journal setup page: the anchor status (last anchored day, chain length). */
export async function latestArchiveAnchor(db: DbExecutor, tenantId: string) {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(archiveAnchor)
      .where(eq(archiveAnchor.tenantId, tenantId))
      .orderBy(desc(archiveAnchor.anchorDate))
      .limit(1);
    return row ?? null;
  });
}
