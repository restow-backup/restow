/**
 * What a restore job has restored so far, kept beside the job's cursor (the
 * cursor store's entries, job_cursor_entries) so a retried attempt of the
 * same job (a drain for an update, an expired attempt, a lost IMAP
 * connection) knows its own earlier work instead of guessing it from the
 * target.
 *
 * Without it a retry only has the target to go by: a Message-ID found in the
 * restore folder. That misses messages without Message-ID, a copy the
 * server re-rendered, and a message whose create went through while its
 * attachments or flags never followed. So the mail engines record per object
 * path:
 *
 *   created  the message exists (`targetRef`), its attachments or flags are
 *            still to come; written before that work starts
 *   done     nothing left to do, with the verdict of its check
 *
 * "done" entries are written in batches (every {@link FLUSH_EVERY} entries or
 * {@link FLUSH_AFTER_MS}, and at the end of the run); a "created" entry at
 * once. What lies between the last flush and an interruption is found by the
 * target-side checks as before. The worker keeps the entries across retries
 * and drops them when the job ends (apps/worker handlers/framework.ts).
 *
 * Every flush writes only the entries that changed since the one before, one
 * row per entry: a restore of a million messages writes each entry once, not
 * the whole record ten thousand times. A flush with nothing new writes
 * nothing, so an attempt that restored nothing leaves no checkpoint (the
 * worker gives an expired attempt back only after progress,
 * apps/worker continuation.ts).
 *
 * Entries are compact: keys are a short hash of the restore job and of the
 * object path (a store only ever holds one job's entries, the job tag keeps
 * it so should one be shared), and a "done" entry keeps its target reference
 * only when it is short (an IMAP mailbox and UID, not a Graph id).
 */
import { createHash } from "node:crypto";
import type { CursorStore } from "../engine/types.js";

export const FLUSH_EVERY = 100;
export const FLUSH_AFTER_MS = 15_000;
/** Longest target reference a "done" entry keeps. */
const MAX_DONE_REF = 100;

export type ProgressEntry =
  | { readonly state: "created"; readonly targetRef: string }
  | { readonly state: "done"; readonly verified: boolean | undefined; readonly targetRef?: string };

function hashOf(value: string, length: number): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, length);
}

function decode(value: string): ProgressEntry | undefined {
  const colon = value.indexOf(":");
  const head = colon === -1 ? value : value.slice(0, colon);
  const ref = colon === -1 ? undefined : value.slice(colon + 1);
  if (head === "c" && ref) {
    return { state: "created", targetRef: ref };
  }
  const verdict = { d1: true, d0: false, "d?": undefined } as const;
  if (head in verdict) {
    const verified = verdict[head as keyof typeof verdict];
    return ref ? { state: "done", verified, targetRef: ref } : { state: "done", verified };
  }
  return undefined;
}

export interface RestoreProgressOptions {
  /** The restore job (restore_jobs.id) the record belongs to. */
  readonly restoreJobId: string;
  /**
   * The job ran before (pg-boss handed it out again: `JobContext.attempt` >
   * 0). A retry checks the target for its own earlier writes even when the
   * earlier attempt was interrupted before it saved anything.
   */
  readonly retry: boolean;
  readonly now?: () => number;
}

export class RestoreProgress {
  /** Entries set since the last flush, by key. */
  private readonly pending = new Map<string, string>();
  private lastFlush: number;

  private constructor(
    private readonly cursor: CursorStore,
    /** Prefix of this job's keys. */
    private readonly tag: string,
    private readonly items: Record<string, string>,
    /** An earlier attempt of this job ran. */
    readonly isRetry: boolean,
    private readonly now: () => number,
  ) {
    this.lastFlush = now();
  }

  /** The record of the job: what its earlier attempts left, or an empty one. Writes nothing. */
  static async open(
    cursor: CursorStore,
    options: RestoreProgressOptions,
  ): Promise<RestoreProgress> {
    const tag = `${hashOf(options.restoreJobId, 4)}.`;
    const items = Object.fromEntries(
      Object.entries(await cursor.loadEntries()).filter(([key]) => key.startsWith(tag)),
    );
    return new RestoreProgress(
      cursor,
      tag,
      items,
      options.retry || Object.keys(items).length > 0,
      options.now ?? Date.now,
    );
  }

  get(path: string): ProgressEntry | undefined {
    const value = this.items[this.keyOf(path)];
    return value === undefined ? undefined : decode(value);
  }

  /** The object exists in the target but is not finished; saved at once. */
  async created(path: string, targetRef: string): Promise<void> {
    this.set(path, `c:${targetRef}`);
    await this.flush();
  }

  /** Nothing left to do for the object; saved with the next batch. */
  async done(path: string, verified: boolean | undefined, targetRef?: string): Promise<void> {
    const head = verified === true ? "d1" : verified === false ? "d0" : "d?";
    this.set(
      path,
      targetRef !== undefined && targetRef.length <= MAX_DONE_REF ? `${head}:${targetRef}` : head,
    );
    if (this.pending.size >= FLUSH_EVERY || this.now() - this.lastFlush >= FLUSH_AFTER_MS) {
      await this.flush();
    }
  }

  /** Save the entries set since the last flush; nothing when there are none. */
  async flush(): Promise<void> {
    this.lastFlush = this.now();
    if (this.pending.size === 0) {
      return;
    }
    const batch = Object.fromEntries(this.pending);
    await this.cursor.putEntries(batch);
    // Entries set while the write ran stay pending for the next flush.
    for (const [key, value] of Object.entries(batch)) {
      if (this.pending.get(key) === value) {
        this.pending.delete(key);
      }
    }
  }

  private keyOf(path: string): string {
    return `${this.tag}${hashOf(path, 16)}`;
  }

  private set(path: string, value: string): void {
    const key = this.keyOf(path);
    if (this.items[key] === value && !this.pending.has(key)) {
      return;
    }
    this.items[key] = value;
    this.pending.set(key, value);
  }
}

/** The note on an item an earlier attempt of the same job restored. */
export const RESTORED_BY_EARLIER_ATTEMPT = "restored by an earlier attempt of this job";
