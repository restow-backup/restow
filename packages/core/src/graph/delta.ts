/**
 * Delta synchronisation with token storage and 410 Gone handling.
 *
 * Every delta stream (a mail folder, a drive) has a stable key. The stored delta
 * link resumes the stream; when Graph answers 410 Gone the token is dropped and
 * only that stream is enumerated again from scratch (docs/MICROSOFT.md: a full
 * resync of that folder, not of the whole mailbox). OneDrive sends a
 * fresh delta URL in the `Location` header of the 410; Outlook does not, so the
 * caller's initial URL is used.
 */
import type { GraphClient } from "./client.js";
import { isGone } from "./errors.js";

/** Persists delta links per stream key (job cursor, database, memory). */
export interface DeltaTokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, deltaLink: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Store for tests and one-off runs. */
export class InMemoryDeltaTokenStore implements DeltaTokenStore {
  private readonly links = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.links.get(key) ?? null;
  }
  async set(key: string, deltaLink: string): Promise<void> {
    this.links.set(key, deltaLink);
  }
  async delete(key: string): Promise<void> {
    this.links.delete(key);
  }
}

/**
 * Store backed by a plain record, so the whole set of delta links can live inside
 * a job cursor or a jsonb column and be serialised as-is.
 */
export class RecordDeltaTokenStore implements DeltaTokenStore {
  constructor(readonly record: Record<string, string> = {}) {}

  async get(key: string): Promise<string | null> {
    const link = Object.hasOwn(this.record, key) ? this.record[key] : undefined;
    return link ?? null;
  }
  async set(key: string, deltaLink: string): Promise<void> {
    this.record[key] = deltaLink;
  }
  async delete(key: string): Promise<void> {
    delete this.record[key];
  }
}

/** How the current run enumerated the stream. */
export type DeltaMode = "initial" | "incremental" | "resync";

/** Why a full enumeration was started although a token existed. */
export type ResyncReason = "gone";

export interface DeltaBatch<T> {
  mode: DeltaMode;
  items: T[];
  /**
   * True on the first batch after a resync started mid-run. Everything yielded
   * earlier in this run belongs to the abandoned enumeration and must be discarded.
   */
  reset: boolean;
}

export interface DeltaSummary {
  mode: DeltaMode;
  deltaLink: string;
  pages: number;
  items: number;
}

export interface DeltaSyncOptions {
  client: GraphClient;
  store: DeltaTokenStore;
  /** Stable stream key, e.g. `mail:<userId>:<folderId>` or `drive:<driveId>`. */
  key: string;
  /** URL of a full enumeration (with `$select` etc.), used when no token is stored. */
  initialUrl: string;
  /** Sent with every page request, e.g. `Prefer: odata.maxpagesize=200`. */
  headers?: Record<string, string>;
  onResync?: (info: { key: string; reason: ResyncReason; nextUrl: string }) => void;
}

/**
 * Enumerate a delta stream page by page, resuming from the stored token, and store
 * the new delta link when the enumeration completes. The generator's return value
 * summarises the run.
 */
export async function* syncDelta<T>(
  options: DeltaSyncOptions,
): AsyncGenerator<DeltaBatch<T>, DeltaSummary, unknown> {
  const stored = await options.store.get(options.key);
  let url = stored ?? options.initialUrl;
  let mode: DeltaMode = stored ? "incremental" : "initial";
  let reset = false;

  for (;;) {
    let pages = 0;
    let items = 0;
    try {
      for await (const page of options.client.delta<T>(url, options.headers)) {
        pages += 1;
        items += page.value.length;
        yield { mode, items: page.value, reset };
        reset = false;
        if (page.deltaLink) {
          await options.store.set(options.key, page.deltaLink);
          return { mode, deltaLink: page.deltaLink, pages, items };
        }
      }
      throw new Error(`Delta stream ${options.key} ended without a delta link`);
    } catch (error) {
      if (!isGone(error) || mode === "resync") {
        throw error;
      }
      await options.store.delete(options.key);
      const nextUrl = error.headers.location ?? options.initialUrl;
      options.onResync?.({ key: options.key, reason: "gone", nextUrl });
      url = nextUrl;
      mode = "resync";
      reset = pages > 0;
    }
  }
}

/** Collect a whole delta run when streaming is not needed (small streams, tests). */
export async function collectDelta<T>(
  options: DeltaSyncOptions,
): Promise<{ items: T[]; summary: DeltaSummary }> {
  const generator = syncDelta<T>(options);
  let items: T[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      return { items, summary: next.value };
    }
    if (next.value.reset) {
      items = [];
    }
    items.push(...next.value.items);
  }
}

/** Outlook delta marks deletions with an `@removed` annotation. */
export interface RemovedAnnotation {
  "@removed"?: { reason?: string };
}

/** True when the delta entry announces a deletion (Outlook `@removed`, OneDrive `deleted`). */
export function isRemoved(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const record = item as Record<string, unknown>;
  return record["@removed"] !== undefined || record.deleted !== undefined;
}
