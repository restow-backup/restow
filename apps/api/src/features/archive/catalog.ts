/**
 * Postgres-backed {@link archive.ArchiveCatalog} (@restow/core archive/types.ts),
 * over the `archive_items` table (packages/db/src/schema/archive.ts).
 *
 * `append` runs on the tenant (RLS) pool: the grants that let a database
 * trigger keep `archive_items` append-only (packages/db/sql/rls.sql) permit
 * INSERT and SELECT for the tenant role, but forbid UPDATE unconditionally
 * and DELETE for the tenant role (only the installation role may delete,
 * which is what the retention deletion run uses, apps/worker/src/handlers/
 * archive-retention.ts). That is also why {@link PgArchiveCatalog.setLegalHold}
 * cannot mutate a row here: legal holds are a separate, append-only concept
 * (the `legal_holds` table, scoped per tenant or per protected mailbox, not a
 * mutable flag on the item itself) — see features/archive/legal-holds.ts.
 */
import { archive } from "@restow/core";
import { type ArchiveEnvelope, archiveItems } from "@restow/db";
import { asc, desc, eq } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";

type ArchiveItemRecord = archive.ArchiveItemRecord;
type ArchiveSource = archive.ArchiveSource;
type CoreEnvelope = archive.JournalEnvelope;
const { ArchiveCatalogDuplicateError } = archive;

function toDbEnvelope(envelope: CoreEnvelope | null): ArchiveEnvelope | null {
  if (!envelope) {
    return null;
  }
  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];
  const recipients: string[] = [];
  for (const recipient of envelope.recipients) {
    recipients.push(recipient.address);
    if (recipient.type === "to") {
      to.push(recipient.address);
    } else if (recipient.type === "cc") {
      cc.push(recipient.address);
    } else {
      bcc.push(recipient.address);
    }
  }
  return { from: envelope.sender ?? undefined, to, cc, bcc, recipients };
}

function toCoreEnvelope(row: ArchiveEnvelope | null, messageId: string): CoreEnvelope | null {
  if (!row) {
    return null;
  }
  const recipients = (row.recipients ?? []).map((address) => {
    const type = (row.to ?? []).includes(address)
      ? ("to" as const)
      : (row.cc ?? []).includes(address)
        ? ("cc" as const)
        : ("bcc" as const);
    return { address, type };
  });
  return { sender: row.from ?? "", subject: null, messageId, onBehalfOf: null, recipients };
}

function toRow(record: ArchiveItemRecord, storagePath: string) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    messageId: record.envelope?.messageId ?? record.id,
    itemHash: record.itemHash,
    prevChainHash: record.prevChainHash,
    chainHash: record.chainHash,
    receivedAt: record.receivedAt,
    capturedVia: record.source,
    retentionUntil: record.retentionUntil,
    storagePath,
    // An item with a retention date; not proof that the target enforced Object Lock.
    objectLock: record.retentionUntil !== null,
    subject: record.envelope?.subject ?? null,
    sizeBytes: record.size,
    envelope: toDbEnvelope(record.envelope),
    chunks: [...record.chunks],
    flags: [...record.flags],
    createdAt: record.createdAt,
  };
}

function fromRow(row: typeof archiveItems.$inferSelect): ArchiveItemRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    receivedAt: row.receivedAt,
    itemHash: row.itemHash,
    prevChainHash: row.prevChainHash,
    chainHash: row.chainHash,
    size: row.sizeBytes ?? 0,
    chunks: row.chunks ?? [],
    envelope: toCoreEnvelope(row.envelope, row.messageId),
    flags: (row.flags ?? []) as ArchiveItemRecord["flags"],
    source: row.capturedVia as ArchiveSource,
    // Per-item legal hold is not a stored column (see module docstring); the
    // catalog reports false here and callers that need the real answer join
    // against `legal_holds` themselves (features/archive/service.ts).
    legalHold: false,
    retentionUntil: row.retentionUntil,
    createdAt: row.createdAt,
  };
}

export interface PgArchiveCatalogOptions {
  readonly db: DbExecutor;
  readonly storagePathOf: (record: ArchiveItemRecord) => string;
}

/** See the module docstring for what this can and cannot do. */
export class PgArchiveCatalog implements archive.ArchiveCatalog {
  constructor(private readonly options: PgArchiveCatalogOptions) {}

  async append(record: ArchiveItemRecord): Promise<void> {
    const row = toRow(record, this.options.storagePathOf(record));
    try {
      await this.options.db.insert(archiveItems).values(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ArchiveCatalogDuplicateError(record.tenantId, record.id);
      }
      throw error;
    }
  }

  async get(tenantId: string, itemId: string): Promise<ArchiveItemRecord | null> {
    const [row] = await this.options.db
      .select()
      .from(archiveItems)
      .where(eq(archiveItems.id, itemId))
      .limit(1);
    return row && row.tenantId === tenantId ? fromRow(row) : null;
  }

  async lastChainHash(tenantId: string): Promise<string | null> {
    // Append order is `created_at` order (the catalog's own contract); the
    // caller (journal/receiver.ts) holds the per-tenant advisory chain lock
    // around this call and the matching append, so two concurrent
    // deliveries can never both read the same predecessor.
    const [row] = await this.options.db
      .select({ chainHash: archiveItems.chainHash })
      .from(archiveItems)
      .where(eq(archiveItems.tenantId, tenantId))
      .orderBy(desc(archiveItems.createdAt))
      .limit(1);
    return row?.chainHash ?? null;
  }

  async chain(tenantId: string): Promise<readonly ArchiveItemRecord[]> {
    const rows = await this.options.db
      .select()
      .from(archiveItems)
      .where(eq(archiveItems.tenantId, tenantId))
      .orderBy(asc(archiveItems.createdAt));
    return rows.map(fromRow);
  }

  async setLegalHold(): Promise<void> {
    throw new Error(
      "archive items are append-only; use the legal_holds table (features/archive/legal-holds.ts) to place or release a hold, not PgArchiveCatalog.setLegalHold",
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}
