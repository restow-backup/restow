/**
 * In-memory {@link ArchiveCatalog}, for this package's own tests and dry
 * runs (docs/TESTING.md: fixtures, never live services). The Postgres-backed
 * implementation comes with the SMTP receiver (ARCHIVE-JOURNAL) and must keep
 * the same "append order is chain order, duplicate id is refused" semantics.
 */
import type {
  ArchiveAppendStore,
  ArchiveCandidateQuery,
  ArchiveCaptureInsert,
  ArchiveChainSession,
  ArchiveChainTip,
  ArchiveItemInsert,
  ArchiveMailboxAssignment,
} from "./append.js";
import { type ArchiveMatchCandidate, messageKey } from "./identity.js";
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

/**
 * In-memory {@link ArchiveAppendStore} for one tenant, for tests of everything built on
 * `captureArchiveItem` (./append.ts). The chain lock is a promise queue; a session whose
 * function throws leaves nothing behind (its writes are applied only on success).
 */
export class InMemoryArchiveAppendStore implements ArchiveAppendStore {
  readonly items: ArchiveItemInsert[] = [];
  readonly captures: ArchiveCaptureInsert[] = [];
  /** `itemId` -> assigned mailboxes (object ids, or `address:<a>` for addresses). */
  readonly assignments = new Map<string, Set<string>>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(readonly tenantId: string) {}

  async candidates(query: ArchiveCandidateQuery): Promise<ArchiveMatchCandidate[]> {
    return candidatesIn(this.items, query);
  }

  withChainLock<T>(fn: (session: ArchiveChainSession) => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      const items: ArchiveItemInsert[] = [];
      const captures: ArchiveCaptureInsert[] = [];
      const assigned: [string, string][] = [];
      const all = () => [...this.items, ...items];
      const session: ArchiveChainSession = {
        tip: async (): Promise<ArchiveChainTip | null> => {
          const last = all().at(-1);
          return last
            ? { chainHash: last.record.chainHash, createdAt: last.record.createdAt }
            : null;
        },
        candidates: async (query) => candidatesIn(all(), query),
        insertItem: async (item) => {
          items.push(item);
        },
        insertCapture: async (capture) => {
          captures.push(capture);
        },
        assignMailboxes: async (itemId, assignment: ArchiveMailboxAssignment) => {
          const own = all().find((item) => item.record.id === itemId)?.protectedObjectId;
          const names = [
            ...(assignment.objectIds ?? []).filter((id) => id !== own),
            ...(assignment.addresses ?? []).map((address) => `address:${address}`),
          ];
          for (const name of names) {
            assigned.push([itemId, name]);
          }
          return new Set(names).size;
        },
      };
      const result = await fn(session);
      this.items.push(...items);
      this.captures.push(...captures);
      for (const [itemId, name] of assigned) {
        const set = this.assignments.get(itemId) ?? new Set<string>();
        set.add(name);
        this.assignments.set(itemId, set);
      }
      return result;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
}

function candidatesIn(
  items: readonly ArchiveItemInsert[],
  query: ArchiveCandidateQuery,
): ArchiveMatchCandidate[] {
  return items
    .filter(
      (item) =>
        item.record.itemHash === query.itemHash ||
        (query.messageKey !== null && messageKey(item.messageId) === query.messageKey),
    )
    .map((item) => ({
      id: item.record.id,
      source: item.record.source,
      itemHash: item.record.itemHash,
      bodyHash: item.bodyHash,
      messageKey: messageKey(item.messageId),
    }));
}
