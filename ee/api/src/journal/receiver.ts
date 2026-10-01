/**
 * The archive journal receiver's processing core: everything from "here are
 * the raw report bytes for this tenant" to a durably committed archive item.
 * Deliberately separate from the SMTP protocol handling (./server.ts) so it
 * can be exercised directly in tests without opening a socket.
 *
 * Durability contract (docs/IMAP.md, journal receiver section): the caller (./server.ts) must not reply 250 to Exchange until
 * {@link receiveJournalReport} resolves; any failure here (storage, database)
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
 * The chain hash lookup and the item's insert are one atomic step: both run
 * inside a transaction that first takes a per-tenant advisory lock (the same
 * pattern apps/api/src/lib/audit.ts uses for the audit chain), so two
 * concurrent deliveries for the same tenant can never claim the same
 * predecessor chain hash.
 */
import { randomUUID } from "node:crypto";
import { type KeyProvider, type Logger, archive } from "@restow/core";
import type { Database } from "@restow/db";
import { sql } from "drizzle-orm";
import { PgArchiveCatalog } from "../../../../apps/api/src/features/archive/catalog.js";
import { type DbExecutor, withTenantTx } from "../../../../apps/api/src/lib/tenant-context.js";
import { PgChunkIndex, loadTenantKeyring, tenantRunner } from "./chunkstore.js";
import { resolveTenantWritableStorage } from "./storage.js";

/** Per-tenant lock key for the archive chain, distinct from the audit chain's own lock key. */
function chainLockKey(tenantId: string): string {
  return `archive-chain:${tenantId}`;
}

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

/**
 * Process one journal report for `tenantId`, all the way to a committed
 * archive item. Never throws for a malformed or hostile report (journal.ts and
 * journal-isolated.ts guarantee that); throws only for infrastructure failure
 * (storage, database, no parser process free or startable), which is exactly
 * what the caller must turn into an SMTP 451.
 */
export async function receiveJournalReport(
  tenantId: string,
  rawBytes: Buffer,
  deps: JournalReceiverDeps,
): Promise<archive.ArchiveItemRecord> {
  const parsed = await archive.parseJournalReportIsolated(rawBytes, deps.parseLimits ?? {});
  const now = deps.now ?? (() => new Date());
  const receivedAt = now();
  const itemId = randomUUID();
  const [keys, retentionPolicy, storage] = await Promise.all([
    loadTenantKeyring({ db: deps.db, tenantId, keyProvider: deps.keyProvider }),
    deps.retentionPolicyFor(tenantId),
    resolveTenantWritableStorage(deps.db, tenantId),
  ]);
  const chunkIndex = new PgChunkIndex(tenantRunner(deps.db, tenantId), tenantId);

  return withTenantTx(deps.db, tenantId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${chainLockKey(tenantId)}))`);
    const catalog = archiveCatalogOn(tx);
    const prevChainHash = await catalog.lastChainHash(tenantId);

    const record = await archive.writeArchiveItem({
      tenantId,
      itemId,
      storage,
      keys,
      index: chunkIndex,
      original: parsed.original,
      receivedAt,
      envelope: parsed.envelope,
      flags: parsed.flags,
      source: "journal",
      retentionPolicy,
      prevChainHash,
      now,
      logger: deps.logger,
    });
    await catalog.append(record);
    return record;
  });
}

function archiveCatalogOn(tx: DbExecutor): PgArchiveCatalog {
  return new PgArchiveCatalog({
    db: tx,
    storagePathOf: (record) =>
      archive.archiveItemKey(record.tenantId, record.receivedAt, record.id),
  });
}
