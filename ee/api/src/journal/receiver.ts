/**
 * The archive journal receiver's processing core: everything from "here are
 * the raw report bytes for this tenant" to a durably committed archive item.
 * Deliberately separate from the SMTP protocol handling (./server.ts) so it
 * can be exercised directly in tests without opening a socket.
 *
 * Since 0.4.4 the receiver takes two kinds of mail ({@link receiveArchiveMail} decides):
 * Exchange journal reports (the `X-MS-Journal-Report` header) as before, source `journal`,
 * and plain copies a provider forwards (source `smtp_forward`, see
 * {@link receiveForwardedCopy}).
 *
 * Durability contract (docs/IMAP.md, journal receiver section): the caller (./server.ts) must not reply 250 to Exchange until
 * {@link receiveArchiveMail} resolves; any failure here (storage, database)
 * must surface as a rejected promise, which the caller turns into a 451 so
 * Exchange retries the delivery. Nothing is ever dropped: even a completely
 * unparseable report is archived, with `journal.ts`'s flags recording why.
 *
 * The report is parsed in an isolated child process with a time and memory
 * limit (packages/core archive/journal-isolated.ts, in the API's parser pool,
 * apps/api/src/lib/parser-pool.ts), never on the event loop of the API. A
 * report that runs over either limit, or whose parser crashes, is archived
 * byte for byte as received, without its details, flagged
 * `report-parse-timeout`, `report-parse-memory-limit` or `report-unparseable`:
 * refusing it would only make Exchange send the same report again until it
 * gives up. When no parser process can take the report now (a full queue,
 * `archive.JournalParserBusyError`, or none could be started), the parse
 * rejects before anything is stored and the caller answers 451.
 *
 * The item goes in through the shared archive append (@restow/core
 * archive/append.ts `captureArchiveItem`, packages/db `PgArchiveAppendStore`):
 * the original is uploaded outside the tenant's chain lock, and the chain hash
 * lookup, the item's insert and its mailbox assignments are one atomic step
 * under that lock, so two concurrent deliveries for the same tenant can never
 * claim the same predecessor chain hash, and neither waits for the other's
 * upload. Every report becomes an item of its own (duplicate policy `keep`,
 * as before 0.4.4); one that arrives after a mailbox capture of the same mail
 * names the item it supersedes.
 */
import { archive, type KeyProvider, type Logger } from "@restow/core";
import { type Database, PgArchiveAppendStore } from "@restow/db";
import { loadTenantKeyring, PgChunkIndex, tenantRunner } from "./chunkstore.js";
import { envelopeAddresses } from "./mailboxes.js";
import type { ArchiveRecipient } from "./recipient.js";
import { resolveTenantWritableStorage } from "./storage.js";

export interface JournalReceiverDeps {
  readonly db: Database;
  readonly keyProvider: KeyProvider;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** The tenant's current archive retention policy (default: 8 years, end of year — see features/archive/retention.ts). */
  readonly retentionPolicyFor: (tenantId: string) => Promise<archive.RetentionPolicy>;
  /** Limits of the isolated parse (default: by the size of the report); tests shorten them. */
  readonly parseLimits?: Pick<
    archive.ParseJournalReportIsolatedOptions,
    "timeoutMs" | "heapLimitMb"
  >;
}

/** One SMTP transaction as the receiver accepted it: one tenant, its recipients. */
export interface ArchiveDelivery {
  readonly tenantId: string;
  /** The accepted recipients, resolved; all of the same tenant (./server.ts enforces it). */
  readonly recipients: readonly ArchiveRecipient[];
  /** `MAIL FROM` (the original sender, or an SRS address); null for the null sender. */
  readonly mailFrom: string | null;
  /** `RCPT TO` as accepted: the archive addresses. */
  readonly rcptTo: readonly string[];
}

/** What became of an accepted message. */
export interface ArchiveReceipt {
  readonly kind: "journal_report" | "forwarded_copy";
  /** `stored`: a new item; `duplicate`: the archive held the mail, a capture row was added. */
  readonly outcome: "stored" | "duplicate";
  readonly itemId: string;
  readonly flags: readonly string[];
}

async function tenantWriteContext(tenantId: string, deps: JournalReceiverDeps) {
  const [keys, retentionPolicy, storage] = await Promise.all([
    loadTenantKeyring({ db: deps.db, tenantId, keyProvider: deps.keyProvider }),
    deps.retentionPolicyFor(tenantId),
    resolveTenantWritableStorage(deps.db, tenantId),
  ]);
  return {
    keys,
    retentionPolicy,
    storage,
    index: new PgChunkIndex(tenantRunner(deps.db, tenantId), tenantId),
    store: new PgArchiveAppendStore(deps.db, tenantId) as archive.ArchiveAppendStore,
  };
}

/**
 * Process one journal report for `tenantId`, all the way to a committed
 * archive item. Never throws for a malformed or hostile report (journal.ts and
 * journal-isolated.ts guarantee that); throws only for infrastructure failure
 * (storage, database, no parser process free or startable), which is exactly
 * what the caller must turn into an SMTP 451. `accounts`: IMAP accounts whose
 * archive address the report was also sent to; it is assigned to them as well.
 */
export async function receiveJournalReport(
  tenantId: string,
  rawBytes: Buffer,
  deps: JournalReceiverDeps,
  accounts: readonly string[] = [],
): Promise<archive.ArchiveItemRecord> {
  const parsed = await archive.parseJournalReportIsolated(rawBytes, deps.parseLimits ?? {});
  const now = deps.now ?? (() => new Date());
  const receivedAt = now();
  const target = await tenantWriteContext(tenantId, deps);
  const result = await archive.captureArchiveItem({
    tenantId,
    ...target,
    original: parsed.original,
    source: "journal",
    receivedAt,
    envelope: parsed.envelope,
    flags: parsed.flags,
    messageId: parsed.envelope.messageId,
    // The mailboxes the envelope names (#32); none keeps the item the tenant's only.
    mailboxes: { addresses: envelopeAddresses(parsed.envelope), objectIds: accounts },
    duplicates: "keep",
    now,
    logger: deps.logger,
  });
  if (result.outcome !== "stored") {
    // Unreachable under the `keep` policy; a report is never dropped.
    throw new Error("a journal report was not stored as an archive item");
  }
  deps.logger?.debug("journal report assigned to mailboxes", {
    itemId: result.record.id,
    mailboxes: result.mailboxes,
  });
  return result.record;
}

/**
 * The mailbox addresses a plain copy to the tenant's journal address is assigned by: the
 * copy's own From/To/Cc/Bcc, the delivered-to headers the provider added, and `MAIL FROM`.
 */
export function forwardedCopyAddresses(
  envelope: archive.JournalEnvelope,
  deliveredTo: readonly string[],
  mailFrom: string | null,
): string[] {
  const addresses = new Set(envelopeAddresses(envelope));
  for (const value of [...deliveredTo, mailFrom ?? ""]) {
    const address = value.trim().toLowerCase();
    if (address.includes("@")) {
      addresses.add(address);
    }
  }
  return [...addresses];
}

/**
 * Archive a plain copy (source `smtp_forward`): parsed in the isolated parser processes
 * (archive.parsePlainCopyIsolated), then through the shared archive append with the
 * duplicate policy `merge`, once per recipient: for an account's archive address it belongs
 * to exactly that account; for the tenant's journal address to the mailboxes its headers
 * and `MAIL FROM` name. The first recipient stores the item (or finds the mail already
 * archived), every further one adds a capture row. A copy that cannot be parsed within the
 * limits is archived without its details, flagged, never refused.
 */
export async function receiveForwardedCopy(
  delivery: ArchiveDelivery,
  rawBytes: Buffer,
  deps: JournalReceiverDeps,
): Promise<ArchiveReceipt> {
  const parsed = await archive.parsePlainCopyIsolated(rawBytes, deps.parseLimits ?? {});
  const now = deps.now ?? (() => new Date());
  const receivedAt = now();
  const target = await tenantWriteContext(delivery.tenantId, deps);
  const envelope: archive.JournalEnvelope = {
    ...parsed.envelope,
    envelopeFrom: delivery.mailFrom,
    envelopeTo: delivery.rcptTo,
    deliveredTo: parsed.deliveredTo,
  };
  const flags: archive.ArchiveFlag[] = [...parsed.flags];
  if (parsed.parseLimit === null && !parsed.messageId) {
    flags.push("message-id-missing");
  }
  // Accounts first (their assignment is certain), the tenant address last.
  const recipients = [...delivery.recipients].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "account" ? -1 : 1,
  );
  let receipt: ArchiveReceipt | null = null;
  for (const recipient of recipients) {
    const result = await archive.captureArchiveItem({
      tenantId: delivery.tenantId,
      ...target,
      original: rawBytes,
      source: "smtp_forward",
      receivedAt,
      envelope,
      flags,
      messageId: parsed.messageId,
      metadata: {
        subject: parsed.subject,
        bodyText: parsed.bodyText,
        hasAttachment: parsed.hasAttachment,
        sentAt: parsed.sentAt,
      },
      retentionPolicy: target.retentionPolicy,
      ...(recipient.kind === "account"
        ? { protectedObjectId: recipient.protectedObjectId }
        : {
            mailboxes: {
              addresses: forwardedCopyAddresses(envelope, parsed.deliveredTo, delivery.mailFrom),
            },
          }),
      duplicates: "merge",
      now,
      logger: deps.logger,
    });
    receipt ??= {
      kind: "forwarded_copy",
      outcome: result.outcome,
      itemId: result.outcome === "stored" ? result.record.id : result.itemId,
      flags,
    };
  }
  if (!receipt) {
    throw new Error("a forwarded copy reached the receiver without a recipient");
  }
  return receipt;
}

/**
 * Process one accepted message (see the module docstring): a journal report goes the
 * journal way, anything else is a forwarded plain copy.
 */
export async function receiveArchiveMail(
  delivery: ArchiveDelivery,
  rawBytes: Buffer,
  deps: JournalReceiverDeps,
): Promise<ArchiveReceipt> {
  if (archive.isJournalReport(rawBytes)) {
    const record = await receiveJournalReport(
      delivery.tenantId,
      rawBytes,
      deps,
      delivery.recipients.flatMap((recipient) =>
        recipient.kind === "account" ? [recipient.protectedObjectId] : [],
      ),
    );
    return { kind: "journal_report", outcome: "stored", itemId: record.id, flags: record.flags };
  }
  return receiveForwardedCopy(delivery, rawBytes, deps);
}
