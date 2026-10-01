/**
 * The archive's persisted item record and its catalog contract. Mirrors the
 * engine's split (engine/types.ts for contracts, engine/memory.ts for the
 * in-memory implementation): the Postgres-backed `ArchiveCatalog` comes with
 * the SMTP receiver (ARCHIVE-JOURNAL); `InMemoryArchiveCatalog` (./memory.ts)
 * is what this package's own tests and any dry run use.
 */
import type { JournalEnvelope, JournalFlag } from "./journal.js";

/** Where an archived item's bytes were captured from (docs/ARCHIVE.md, the capture paths section). */
/** `file_import` = mail imported from files into an imported mailbox and archived with it (docs/IMPORT.md). */
export type ArchiveSource = "journal" | "graph_sync" | "imap_sync" | "file_import";

/**
 * One archived item, as written by {@link writeArchiveItem} (./writer.ts) and
 * as read back by the catalog or from storage (./reader.ts). This is also
 * exactly what is sealed into the item's storage object (./format.ts), so a
 * standalone restore that can decrypt it needs nothing else.
 */
export interface ArchiveItemRecord {
  /** Catalog identity, assigned by the caller (the journal receiver, IMAP sync). */
  readonly id: string;
  readonly tenantId: string;
  /** When the item was captured (journal delivery time, or IMAP sync time). */
  readonly receivedAt: Date;
  /** SHA-256 (hex) of `original`, byte-exact. */
  readonly itemHash: string;
  /** The predecessor's chain hash, or null for the first item of the tenant's chain. */
  readonly prevChainHash: string | null;
  /** `SHA-256(prevChainHash || itemHash || receivedAt)` (./chain.ts). */
  readonly chainHash: string;
  /** Plaintext size of the original, in bytes. */
  readonly size: number;
  /** Ordered stored chunk ids (hex) that reconstruct `original` via the chunk store. */
  readonly chunks: readonly string[];
  /** Null for sources that do not carry a journal envelope (Graph sync, IMAP sync). */
  readonly envelope: JournalEnvelope | null;
  readonly flags: readonly JournalFlag[];
  readonly source: ArchiveSource;
  readonly legalHold: boolean;
  /** Computed retention date, or null for unlimited retention (./retention.ts). */
  readonly retentionUntil: Date | null;
  /** When this record was written (not necessarily `receivedAt`: backfilled Graph sync differs). */
  readonly createdAt: Date;
}

/** An item id already exists in the catalog. */
export class ArchiveCatalogDuplicateError extends Error {
  constructor(
    readonly tenantId: string,
    readonly itemId: string,
  ) {
    super(`archive item ${itemId} already exists for tenant ${tenantId}`);
    this.name = "ArchiveCatalogDuplicateError";
  }
}

/**
 * Persistence for archived items, independent of the storage backend they
 * are written to. `chain()` returns entries in append (chain) order, which is
 * also insertion order — never re-sorted by `receivedAt`, since a chain's
 * order is what {@link verifyChain} (./chain.ts) checks.
 */
export interface ArchiveCatalog {
  /** Append a new item. Throws {@link ArchiveCatalogDuplicateError} if `record.id` already exists for the tenant. */
  append(record: ArchiveItemRecord): Promise<void>;
  get(tenantId: string, itemId: string): Promise<ArchiveItemRecord | null>;
  /** The chain hash of the last appended item, or null for an empty chain. */
  lastChainHash(tenantId: string): Promise<string | null>;
  /** The full chain, in append order. */
  chain(tenantId: string): Promise<readonly ArchiveItemRecord[]>;
  /** Flip legal hold on one item (audited by the caller, not by the catalog). */
  setLegalHold(tenantId: string, itemId: string, legalHold: boolean): Promise<void>;
}
