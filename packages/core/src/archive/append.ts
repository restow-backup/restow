/**
 * The one way an item enters a tenant's archive (0.4.4): the journal receiver, the file
 * import and the mailbox capture ways all call {@link captureArchiveItem}.
 *
 *   1. Hashes first (exact bytes, body, Message-ID; ./identity.ts). Under the `merge`
 *      policy a capture the archive already holds at least as strongly is decided before
 *      anything is uploaded.
 *   2. The original is chunked and uploaded outside the chain lock
 *      (./writer.ts `storeArchiveContent`): the slow part never blocks other captures of
 *      the tenant. Nothing references the chunks yet; scrub GC's grace period keeps them.
 *   3. Under the tenant's chain lock ({@link ArchiveAppendStore.withChainLock}) the
 *      duplicate decision is made again (another capture may have won meanwhile), then
 *      either a capture row on the existing item, or: the chain tip, a `createdAt`
 *      strictly after it, the chunks pinned, the sealed record written and the item row,
 *      its mailbox assignments and nothing else inserted in that same transaction.
 *
 * `createdAt` strictly increasing per tenant is what keeps the chain from forking: every
 * writer reads its predecessor as the last item in (created_at, id) order, the order
 * chain verification walks, and a later item can never sort before it whatever the
 * clocks of the processes say.
 *
 * The core never queries Postgres: the store is injected (packages/db archive-append.ts
 * `PgArchiveAppendStore`; an in-memory one in the tests).
 */
import { randomUUID } from "node:crypto";
import { nextCreatedAt } from "../audit-chain.js";
import type { ChunkIndex, Logger, StorageTargets, TenantKeyring } from "../engine/types.js";
import {
  type ArchiveMatchCandidate,
  bodyHash as bodyHashOf,
  type CaptureIdentity,
  type DuplicatePolicy,
  decideDuplicate,
  itemHashOf,
  messageKey as messageKeyOf,
} from "./identity.js";
import type { JournalEnvelope } from "./journal.js";
import { archiveItemKey } from "./layout.js";
import type { RetentionPolicy } from "./retention.js";
import type { ArchiveFlag, ArchiveItemRecord, ArchiveSource } from "./types.js";
import { type ArchiveContent, commitArchiveItem, storeArchiveContent } from "./writer.js";

/** The last item of a tenant's chain, in (created_at, id) order. */
export interface ArchiveChainTip {
  readonly chainHash: string;
  /** Its `created_at`, rounded up to the millisecond. */
  readonly createdAt: Date;
}

/** Which items may be the same mail as a capture. */
export interface ArchiveCandidateQuery {
  readonly itemHash: string;
  readonly messageKey: string | null;
}

/** Which mailboxes an item (or a capture of it) belongs to, besides its own. */
export interface ArchiveMailboxAssignment {
  /** Protected objects by id. */
  readonly objectIds?: readonly string[];
  /** Addresses a mailbox of the tenant has (journal envelopes, forwarded copies' headers). */
  readonly addresses?: readonly string[];
}

/** The catalog row of a new item: the record plus what search and display need. */
export interface ArchiveItemInsert {
  readonly record: ArchiveItemRecord;
  readonly storagePath: string;
  /** The mailbox the item was captured for (imports, mailbox captures); null for journal mail. */
  readonly protectedObjectId: string | null;
  /** The Message-ID as found; the catalog stores the item id when there is none. */
  readonly messageId: string | null;
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly hasAttachment: boolean;
  readonly sentAt: Date | null;
  readonly bodyHash: string;
  readonly externalRef: string | null;
  readonly supersedesItemId: string | null;
}

/** A further capture of an existing item (no chain entry). */
export interface ArchiveCaptureInsert {
  readonly tenantId: string;
  readonly archiveItemId: string;
  readonly source: ArchiveSource;
  readonly protectedObjectId: string | null;
  readonly itemHash: string;
  readonly externalRef: string | null;
  readonly receivedAt: Date;
  readonly flags: readonly ArchiveFlag[];
}

/** What a store offers inside the chain lock: one transaction, the lock held. */
export interface ArchiveChainSession {
  tip(): Promise<ArchiveChainTip | null>;
  candidates(query: ArchiveCandidateQuery): Promise<ArchiveMatchCandidate[]>;
  insertItem(item: ArchiveItemInsert): Promise<void>;
  insertCapture(capture: ArchiveCaptureInsert): Promise<void>;
  /** Assign `itemId` to the mailboxes named (never to its own); returns how many rows were added. */
  assignMailboxes(itemId: string, assignment: ArchiveMailboxAssignment): Promise<number>;
}

/** Persistence of one tenant's archive appends (packages/db `PgArchiveAppendStore`). */
export interface ArchiveAppendStore {
  readonly tenantId: string;
  /** Candidates outside the lock: only a hint (the decision is made again under it). */
  candidates(query: ArchiveCandidateQuery): Promise<ArchiveMatchCandidate[]>;
  /** Run `fn` in one transaction holding the tenant's chain lock. */
  withChainLock<T>(fn: (session: ArchiveChainSession) => Promise<T>): Promise<T>;
}

/** The catalog fields a capture path knows about its mail. */
export interface ArchiveItemMetadata {
  readonly subject?: string | null;
  readonly bodyText?: string | null;
  readonly hasAttachment?: boolean;
  readonly sentAt?: Date | null;
}

export interface CaptureArchiveItemOptions {
  readonly tenantId: string;
  readonly storage: StorageTargets;
  readonly keys: TenantKeyring;
  readonly index: ChunkIndex;
  readonly store: ArchiveAppendStore;
  /** The mail, byte-exact. */
  readonly original: Buffer;
  readonly source: ArchiveSource;
  /** When the mail was captured (retention counts from here). */
  readonly receivedAt: Date;
  readonly envelope: JournalEnvelope | null;
  readonly flags: readonly ArchiveFlag[];
  /** The Message-ID header (with or without angle brackets), or null. */
  readonly messageId: string | null;
  readonly metadata?: ArchiveItemMetadata;
  readonly retentionPolicy: RetentionPolicy;
  readonly legalHold?: boolean;
  /** The mailbox the mail was captured for; null for journal and tenant-address mail. */
  readonly protectedObjectId?: string | null;
  /** Further mailboxes the mail belongs to. */
  readonly mailboxes?: ArchiveMailboxAssignment;
  /** Where a mailbox capture found it (Graph immutable id, IMAP `folder;uidvalidity;uid`). */
  readonly externalRef?: string | null;
  /** Default `merge` (see ./identity.ts {@link DuplicatePolicy}). */
  readonly duplicates?: DuplicatePolicy;
  /** The new item's id; default a random UUID. */
  readonly itemId?: string;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

export type CaptureArchiveItemResult =
  | {
      readonly outcome: "stored";
      readonly record: ArchiveItemRecord;
      /** Mailbox assignments written besides the item's own. */
      readonly mailboxes: number;
    }
  | {
      readonly outcome: "duplicate";
      /** The existing item this capture was recorded on. */
      readonly itemId: string;
      readonly mailboxes: number;
    };

/** Capture one mail into the tenant's archive (see the module docstring). */
export async function captureArchiveItem(
  options: CaptureArchiveItemOptions,
): Promise<CaptureArchiveItemResult> {
  const policy = options.duplicates ?? "merge";
  const now = options.now ?? (() => new Date());
  const identity: CaptureIdentity = {
    source: options.source,
    itemHash: itemHashOf(options.original),
    bodyHash: bodyHashOf(options.original),
    messageKey: messageKeyOf(options.messageId),
  };
  const query: ArchiveCandidateQuery = {
    itemHash: identity.itemHash,
    messageKey: identity.messageKey,
  };

  // A capture the archive already holds needs no upload at all.
  let content: ArchiveContent | null = null;
  const hint =
    policy === "merge"
      ? decideDuplicate(identity, await options.store.candidates(query), policy)
      : null;
  if (hint?.kind !== "duplicate") {
    content = await store(options);
  }

  return options.store.withChainLock(async (session) => {
    const decision = decideDuplicate(identity, await session.candidates(query), policy);
    if (decision.kind === "duplicate") {
      await session.insertCapture({
        tenantId: options.tenantId,
        archiveItemId: decision.of,
        source: options.source,
        protectedObjectId: options.protectedObjectId ?? null,
        itemHash: identity.itemHash,
        externalRef: options.externalRef ?? null,
        receivedAt: options.receivedAt,
        flags: options.flags,
      });
      const mailboxes = await session.assignMailboxes(decision.of, {
        objectIds: [
          ...(options.protectedObjectId ? [options.protectedObjectId] : []),
          ...(options.mailboxes?.objectIds ?? []),
        ],
        addresses: options.mailboxes?.addresses ?? [],
      });
      options.logger?.debug("archive capture recorded on an existing item", {
        itemId: decision.of,
        source: options.source,
      });
      return { outcome: "duplicate", itemId: decision.of, mailboxes };
    }

    // Rare: the hint said duplicate, but that item is gone (retention) by now.
    const stored = content ?? (await store(options));
    const tip = await session.tip();
    const itemId = options.itemId ?? randomUUID();
    const flags: ArchiveFlag[] = [...options.flags];
    if (decision.conflict && !flags.includes("message-id-conflict")) {
      flags.push("message-id-conflict");
    }
    const record = await commitArchiveItem({
      tenantId: options.tenantId,
      itemId,
      storage: options.storage,
      keys: options.keys,
      index: options.index,
      content: stored,
      receivedAt: options.receivedAt,
      envelope: options.envelope,
      flags,
      source: options.source,
      retentionPolicy: options.retentionPolicy,
      legalHold: options.legalHold,
      prevChainHash: tip?.chainHash ?? null,
      createdAt: nextCreatedAt(tip?.createdAt ?? null, now()),
      bodyHash: identity.bodyHash ?? undefined,
      ...(decision.supersedes ? { supersedesItemId: decision.supersedes } : {}),
    });
    await session.insertItem({
      record,
      storagePath: archiveItemKey(record.tenantId, record.receivedAt, record.id),
      protectedObjectId: options.protectedObjectId ?? null,
      messageId: options.messageId,
      subject: options.metadata?.subject ?? options.envelope?.subject ?? null,
      bodyText: options.metadata?.bodyText ?? null,
      hasAttachment: options.metadata?.hasAttachment ?? false,
      sentAt: options.metadata?.sentAt ?? null,
      bodyHash: identity.bodyHash as string,
      externalRef: options.externalRef ?? null,
      supersedesItemId: decision.supersedes,
    });
    const mailboxes = await session.assignMailboxes(record.id, {
      objectIds: options.mailboxes?.objectIds ?? [],
      addresses: options.mailboxes?.addresses ?? [],
    });
    return { outcome: "stored", record, mailboxes };
  });
}

function store(options: CaptureArchiveItemOptions): Promise<ArchiveContent> {
  return storeArchiveContent({
    tenantId: options.tenantId,
    storage: options.storage,
    keys: options.keys,
    index: options.index,
    original: options.original,
    logger: options.logger,
  });
}
