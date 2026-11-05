/**
 * The archive check behind "Kette prüfen" (docs/ARCHIVE.md): three separate
 * checks, each reported with what it covered, so the result never claims
 * more than was looked at.
 *
 * 1. Links: every entry's chain hash is recomputed from its predecessor
 *    (@restow/core archive/chain.ts). Catches a changed hash, a removed or a
 *    reordered entry anywhere but at the very end. An item the deletion run
 *    removed after its retention left a tombstone (`archive_chain_tombstones`)
 *    that takes its place in the walk and is verified the same way; the
 *    result counts those as documented deletions, never as a break.
 * 2. Daily anchors: the chain must still reach every sealed anchor
 *    (`archive_anchor`, written nightly by the worker) with the same hash at
 *    the same position. Catches entries cut off the end of the chain up to
 *    the newest anchor, which the links alone cannot: nothing is left to
 *    disagree. Entries captured after the newest anchor are not covered yet.
 * 3. Content sample: a random sample of messages is read from storage and
 *    compared byte for byte with the size and SHA-256 recorded at capture.
 *    The links and anchors are about database rows; only this check looks at
 *    the stored messages themselves, and only at the sample.
 */
import type { ChunkReader } from "@restow/core";
import { archive } from "@restow/core";
import { archiveAnchor, archiveChainTombstones, archiveItems } from "@restow/db";
import { asc, desc, eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type DbExecutor, type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { openContentReader } from "../snapshots/content.js";
import {
  type ArchiveContentProblem,
  type ArchiveContentRow,
  archiveContentObject,
  contentProblemOf,
  readArchiveContent,
} from "./content.js";

/** Rows read per round trip while walking the chain. */
export const CHAIN_PAGE = 5000;

/** Upper bound of the content sample one check reads. */
export const MAX_CONTENT_SAMPLE = 100;

export interface ChainEntryRef {
  /** 0-based index into the chain (kept for API clients of the first version). */
  index: number;
  /** 1-based position in the chain, as a person counts. */
  position: number;
  itemId: string;
  subject: string | null;
  receivedAt: string;
}

export interface ChainBreakDto extends ChainEntryRef {
  expectedChainHash: string;
  actualChainHash: string;
}

export interface AnchorFailureDto {
  /** The UTC day the anchor sealed. */
  date: string;
  /** Number of entries the chain had at the end of that day. */
  count: number;
  /** `missing`: the chain is shorter than the anchor; `mismatch`: another hash at that position. */
  reason: "missing" | "mismatch";
}

export interface ContentFailureDto {
  itemId: string;
  subject: string | null;
  receivedAt: string;
  problem: ArchiveContentProblem;
}

export interface ChainVerificationDto {
  /** All three checks passed (an empty archive counts as passed). */
  ok: boolean;
  checkedAt: string;
  /** Entries whose links were recomputed: the whole chain, tombstones included. */
  checked: number;
  /**
   * Entries of items deleted after their retention: their tombstone keeps the link and the
   * position (documented in the audit log, `archive.item.deleted`). Not a break.
   */
  deleted: {
    count: number;
    /** When the last deletion ran, or null. */
    lastDeletedAt: string | null;
  };
  /** The first broken link, or null. */
  brokenAt: ChainBreakDto | null;
  anchors: {
    /** Sealed anchors compared with the chain. */
    checked: number;
    /** The newest anchor's day, or null when none was sealed yet. */
    latestDate: string | null;
    /** Entries after the newest anchor: not covered by the anchor check yet. */
    unsealed: number;
    /** The oldest anchor the chain no longer agrees with, or null. */
    failed: AnchorFailureDto | null;
  };
  content: {
    /** Messages the check asked to read. */
    requested: number;
    /** Messages read and compared with their recorded SHA-256 (passed or failed). */
    checked: number;
    /**
     * Sampled messages archived before their chunk list and size were recorded:
     * they cannot be compared this way and count neither as passed nor as failed.
     */
    notRecorded: number;
    failures: ContentFailureDto[];
  };
}

export interface VerifyOptions {
  /** Messages to read back from storage (0 to skip the content check). */
  readonly contentSample: number;
  readonly actor: { userId: string | null; label: string; ip: string | null };
  /** The reader for the content sample (tests); defaults to the tenant's chunk store. */
  readonly openReader?: (tx: DbExecutor, tenantId: string) => Promise<ChunkReader>;
  readonly now?: () => Date;
}

interface WalkedRow {
  id: string;
  itemHash: string;
  receivedAt: Date;
  chainHash: string;
  subject: string | null;
  createdAt: string;
  /** A tombstone: the item was deleted after its retention, its chain link stays. */
  deleted: boolean;
}

function refOf(row: WalkedRow, index: number): ChainEntryRef {
  return {
    index,
    position: index + 1,
    itemId: row.id,
    subject: row.subject,
    receivedAt: row.receivedAt.toISOString(),
  };
}

/** `received_at` as an ISO 8601 string with milliseconds, the precision the hash covers. */
const ISO_MS = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

/**
 * One page of the chain: items and the tombstones of items deleted after their retention
 * (`archive_chain_tombstones`, written by the deletion run), merged in (created_at, id) order,
 * the order the chain was appended in.
 */
async function chainPage(
  tx: Transaction,
  tenantId: string,
  after: { createdAt: string; id: string } | null,
): Promise<WalkedRow[]> {
  const itemsAfter = after
    ? sql`and (ai.created_at, ai.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
    : sql``;
  const tombstonesAfter = after
    ? sql`and (t.item_created_at, t.item_id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
    : sql``;
  const result = await tx.execute<{
    id: string;
    item_hash: string;
    received_text: string;
    chain_hash: string;
    subject: string | null;
    created_text: string;
    deleted: boolean;
  }>(sql`
    select id, item_hash, received_text, chain_hash, subject, created_text, deleted from (
      (select ai.id, ai.item_hash, to_char(ai.received_at at time zone 'UTC', ${ISO_MS}) as received_text, ai.chain_hash,
              ai.subject, ai.created_at::text as created_text, false as deleted,
              ai.created_at as sort_at
         from ${archiveItems} ai
        where ai.tenant_id = ${tenantId}::uuid ${itemsAfter}
        order by ai.created_at, ai.id
        limit ${CHAIN_PAGE})
      union all
      (select t.item_id, t.item_hash, to_char(t.received_at at time zone 'UTC', ${ISO_MS}), t.chain_hash, null,
              t.item_created_at::text, true, t.item_created_at
         from ${archiveChainTombstones} t
        where t.tenant_id = ${tenantId}::uuid ${tombstonesAfter}
        order by t.item_created_at, t.item_id
        limit ${CHAIN_PAGE})
    ) merged
    order by sort_at, id
    limit ${CHAIN_PAGE}`);
  return result.rows.map((row) => ({
    id: row.id,
    itemHash: row.item_hash,
    receivedAt: new Date(row.received_text),
    chainHash: row.chain_hash,
    subject: row.subject,
    // Full database precision for the page boundary (a Date drops microseconds).
    createdAt: row.created_text,
    deleted: row.deleted,
  }));
}

/** Walk the chain in append order, page by page, checking links and anchors on the way. */
async function walkChain(tx: Transaction, tenantId: string) {
  const anchors = await tx
    .select({
      date: archiveAnchor.anchorDate,
      lastHash: archiveAnchor.lastHash,
      count: archiveAnchor.count,
    })
    .from(archiveAnchor)
    .where(eq(archiveAnchor.tenantId, tenantId))
    .orderBy(asc(archiveAnchor.anchorDate));
  // Several anchors can name the same count only if nothing was captured in between; any one decides.
  const anchorsAt = new Map<number, (typeof anchors)[number][]>();
  for (const anchor of anchors) {
    anchorsAt.set(anchor.count, [...(anchorsAt.get(anchor.count) ?? []), anchor]);
  }
  const anchorFailures: AnchorFailureDto[] = [];

  let brokenAt: ChainBreakDto | null = null;
  let prev: string | null = null;
  let index = 0;
  let deleted = 0;
  let lastDeletedAt: Date | null = null;
  let after: { createdAt: string; id: string } | null = null;
  for (;;) {
    const page = await chainPage(tx, tenantId, after);
    for (const row of page) {
      if (brokenAt === null) {
        // A tombstone is verified exactly like the item it replaces: a forged or moved one
        // breaks the chain, and a row removed without one still leaves a gap that does.
        const expected = archive.computeArchiveChainHash(prev, row.itemHash, row.receivedAt);
        if (expected !== row.chainHash) {
          brokenAt = {
            ...refOf(row, index),
            expectedChainHash: expected,
            actualChainHash: row.chainHash,
          };
        }
      }
      if (row.deleted) {
        deleted += 1;
      }
      prev = row.chainHash;
      index += 1;
      for (const anchor of anchorsAt.get(index) ?? []) {
        if (anchor.lastHash !== row.chainHash) {
          anchorFailures.push({ date: anchor.date, count: anchor.count, reason: "mismatch" });
        }
      }
    }
    const last = page[page.length - 1];
    if (!last || page.length < CHAIN_PAGE) {
      break;
    }
    after = { createdAt: last.createdAt, id: last.id };
  }
  if (deleted > 0) {
    const [latest] = await tx
      .select({ deletedAt: archiveChainTombstones.deletedAt })
      .from(archiveChainTombstones)
      .where(eq(archiveChainTombstones.tenantId, tenantId))
      .orderBy(desc(archiveChainTombstones.deletedAt))
      .limit(1);
    lastDeletedAt = latest?.deletedAt ?? null;
  }
  const length = index;
  for (const anchor of anchors) {
    if (anchor.count > length) {
      anchorFailures.push({ date: anchor.date, count: anchor.count, reason: "missing" });
    }
  }
  anchorFailures.sort((a, b) => a.date.localeCompare(b.date));
  const newest = anchors[anchors.length - 1] ?? null;
  return {
    length,
    brokenAt,
    deleted: { count: deleted, lastDeletedAt: lastDeletedAt?.toISOString() ?? null },
    anchors: {
      checked: anchors.length,
      latestDate: newest?.date ?? null,
      unsealed: Math.max(0, length - (newest?.count ?? 0)),
      failed: anchorFailures[0] ?? null,
    },
  };
}

/** Read a random sample of messages back and compare each with its recorded SHA-256. */
async function checkContentSample(
  tx: Transaction,
  tenantId: string,
  sample: number,
  openReader: (tx: DbExecutor, tenantId: string) => Promise<ChunkReader>,
) {
  if (sample <= 0) {
    return { requested: 0, checked: 0, notRecorded: 0, failures: [] as ContentFailureDto[] };
  }
  const rows: (ArchiveContentRow & { subject: string | null })[] = await tx
    .select({
      id: archiveItems.id,
      itemHash: archiveItems.itemHash,
      sizeBytes: archiveItems.sizeBytes,
      chunks: archiveItems.chunks,
      receivedAt: archiveItems.receivedAt,
      subject: archiveItems.subject,
    })
    .from(archiveItems)
    .where(eq(archiveItems.tenantId, tenantId))
    .orderBy(sql`random()`)
    .limit(sample);
  const failures: ContentFailureDto[] = [];
  const readable = rows.filter((row) => archiveContentObject(row) !== null);
  let reader: ChunkReader | null = null;
  let readerError: unknown = null;
  try {
    reader = readable.length > 0 ? await openReader(tx, tenantId) : null;
  } catch (error) {
    readerError = error;
  }
  for (const row of readable) {
    try {
      if (!reader) {
        throw readerError;
      }
      await readArchiveContent(reader, row);
    } catch (error) {
      failures.push({
        itemId: row.id,
        subject: row.subject,
        receivedAt: row.receivedAt.toISOString(),
        problem: contentProblemOf(error),
      });
    }
  }
  return {
    requested: sample,
    checked: readable.length,
    notRecorded: rows.length - readable.length,
    failures,
  };
}

/** Run the archive check for a tenant and audit its outcome. */
export async function verifyArchive(
  db: DbExecutor,
  tenantId: string,
  options: VerifyOptions,
): Promise<ChainVerificationDto> {
  const sample = Math.max(0, Math.min(MAX_CONTENT_SAMPLE, Math.floor(options.contentSample)));
  const now = options.now ?? (() => new Date());
  return withTenantTx(db, tenantId, async (tx) => {
    const walked = await walkChain(tx, tenantId);
    const content = await checkContentSample(
      tx,
      tenantId,
      sample,
      options.openReader ?? openContentReader,
    );
    const ok =
      walked.brokenAt === null && walked.anchors.failed === null && content.failures.length === 0;
    const result: ChainVerificationDto = {
      ok,
      checkedAt: now().toISOString(),
      checked: walked.length,
      deleted: walked.deleted,
      brokenAt: walked.brokenAt,
      anchors: walked.anchors,
      content,
    };
    await audit(tx, {
      tenantId,
      actor: options.actor.label,
      actorUserId: options.actor.userId,
      action: "archive.chain.verified",
      target: null,
      targetType: null,
      ip: options.actor.ip,
      details: {
        ok,
        checked: result.checked,
        deleted: result.deleted.count,
        brokenAtPosition: result.brokenAt?.position ?? null,
        brokenAtItem: result.brokenAt?.itemId ?? null,
        anchorsChecked: result.anchors.checked,
        anchorFailed: result.anchors.failed?.date ?? null,
        unsealed: result.anchors.unsealed,
        contentChecked: content.checked,
        contentNotRecorded: content.notRecorded,
        contentFailed: content.failures.map((failure) => failure.itemId),
      },
    });
    return result;
  });
}
