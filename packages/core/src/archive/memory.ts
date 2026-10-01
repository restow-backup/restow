/**
 * In-memory {@link ArchiveCatalog}, for this package's own tests and dry
 * runs (docs/TESTING.md: fixtures, never live services). The Postgres-backed
 * implementation comes with the SMTP receiver (ARCHIVE-JOURNAL) and must keep
 * the same "append order is chain order, duplicate id is refused" semantics.
 */
import {
  type ArchiveCatalog,
  ArchiveCatalogDuplicateError,
  type ArchiveItemRecord,
} from "./types.js";

export class InMemoryArchiveCatalog implements ArchiveCatalog {
  private readonly chains = new Map<string, ArchiveItemRecord[]>();

  private chainFor(tenantId: string): ArchiveItemRecord[] {
    let entries = this.chains.get(tenantId);
    if (!entries) {
      entries = [];
      this.chains.set(tenantId, entries);
    }
    return entries;
  }

  async append(record: ArchiveItemRecord): Promise<void> {
    const entries = this.chainFor(record.tenantId);
    if (entries.some((entry) => entry.id === record.id)) {
      throw new ArchiveCatalogDuplicateError(record.tenantId, record.id);
    }
    entries.push(record);
  }

  async get(tenantId: string, itemId: string): Promise<ArchiveItemRecord | null> {
    return this.chainFor(tenantId).find((entry) => entry.id === itemId) ?? null;
  }

  async lastChainHash(tenantId: string): Promise<string | null> {
    const entries = this.chainFor(tenantId);
    return entries.length > 0 ? (entries[entries.length - 1] as ArchiveItemRecord).chainHash : null;
  }

  async chain(tenantId: string): Promise<readonly ArchiveItemRecord[]> {
    return [...this.chainFor(tenantId)];
  }

  async setLegalHold(tenantId: string, itemId: string, legalHold: boolean): Promise<void> {
    const entries = this.chainFor(tenantId);
    const index = entries.findIndex((entry) => entry.id === itemId);
    if (index === -1) {
      throw new Error(`archive item ${itemId} does not exist for tenant ${tenantId}`);
    }
    entries[index] = { ...(entries[index] as ArchiveItemRecord), legalHold };
  }
}
