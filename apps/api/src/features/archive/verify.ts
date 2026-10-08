/**
 * The archive check behind "Kette prüfen" (docs/ARCHIVE.md): three separate
 * checks, each reported with what it covered, so the result never claims
 * more than was looked at.
 *
 * 1. Links: every entry's chain hash is recomputed from its predecessor
 *    (@restow/core archive/chain.ts). Catches a changed hash, a removed or a
 *    reordered entry anywhere but at the very end.
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
import { archiveAnchor, archiveItems } from "@restow/db";
import { and, asc, eq, sql } from "drizzle-orm";
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
  /** Entries whose links were recomputed: the whole chain. */
  checked: number;
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
  let after: { createdAt: string; id: string } | null = null;
  for (;;) {
    const page: WalkedRow[] = await tx
      .select({
        id: archiveItems.id,
        itemHash: archiveItems.itemHash,
        receivedAt: archiveItems.receivedAt,
        chainHash: archiveItems.chainHash,
        subject: archiveItems.subject,
        // Full database precision for the page boundary (a Date drops microseconds).
        createdAt: sql<string>`${archiveItems.createdAt}::text`,
      })
      .from(archiveItems)
      .where(
        and(
          eq(archiveItems.tenantId, tenantId),
          after
            ? sql`(${archiveItems.createdAt}, ${archiveItems.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(archiveItems.createdAt), asc(archiveItems.id))
      .limit(CHAIN_PAGE);
    for (const row of page) {
      if (brokenAt === null) {
        const expected = archive.computeArchiveChainHash(prev, row.itemHash, row.receivedAt);
        if (expected !== row.chainHash) {
          brokenAt = {
            ...refOf(row, index),
            expectedChainHash: expected,
            actualChainHash: row.chainHash,
          };
        }
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
