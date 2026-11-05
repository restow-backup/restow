/**
 * What a restore job has restored so far, kept in the job's cursor so a
 * retried attempt of the same job (a drain for an update, an expired
 * attempt, a lost IMAP connection) knows its own earlier work instead of
 * guessing it from the target.
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
 * target-side checks as before. The worker keeps the cursor across retries
 * and clears it when the job ends (apps/worker handlers/framework.ts).
 *
 * The record is compact: keys are a short hash of the object path, and a
 * "done" entry keeps its target reference only when it is short (an IMAP
 * mailbox and UID, not a Graph id).
 */
import { createHash } from "node:crypto";
import type { CursorStore } from "../engine/types.js";

/** Cursor key of the record; its value names the restore job it belongs to. */
export const RESTORE_PROGRESS_CURSOR_KEY = "restoreProgress";

export const FLUSH_EVERY = 100;
export const FLUSH_AFTER_MS = 15_000;
/** Longest target reference a "done" entry keeps. */
const MAX_DONE_REF = 100;

export type ProgressEntry =
  | { readonly state: "created"; readonly targetRef: string }
  | { readonly state: "done"; readonly verified: boolean | undefined; readonly targetRef?: string };

interface StoredProgress {
  readonly job: string;
  readonly items: Record<string, string>;
}

function keyOf(path: string): string {
  return createHash("sha256").update(path).digest("base64url").slice(0, 16);
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

export class RestoreProgress {
  private pending = 0;
  private lastFlush: number;

  private constructor(
    private readonly cursor: CursorStore,
    private readonly job: string,
    private readonly items: Record<string, string>,
    /** An earlier attempt of this job ran (it left a record). */
    readonly isRetry: boolean,
    private readonly now: () => number,
  ) {
    this.lastFlush = now();
  }

  /**
   * The record of `restoreJobId`: what an earlier attempt left, or a fresh
   * one, which is saved at once so a retry knows that this attempt ran.
   */
  static async open(
    cursor: CursorStore,
    restoreJobId: string,
    now: () => number = Date.now,
  ): Promise<RestoreProgress> {
    const stored = (await cursor.load())?.[RESTORE_PROGRESS_CURSOR_KEY] as
      | StoredProgress
      | undefined;
    const earlier =
      stored !== undefined &&
      stored.job === restoreJobId &&
      typeof stored.items === "object" &&
      stored.items !== null;
    const progress = new RestoreProgress(
      cursor,
      restoreJobId,
      earlier ? { ...stored.items } : {},
      earlier,
      now,
    );
    if (!earlier) {
      await progress.flush();
    }
    return progress;
  }

  get(path: string): ProgressEntry | undefined {
    const value = this.items[keyOf(path)];
    return value === undefined ? undefined : decode(value);
  }

  /** The object exists in the target but is not finished; saved at once. */
  async created(path: string, targetRef: string): Promise<void> {
    this.items[keyOf(path)] = `c:${targetRef}`;
    await this.flush();
  }

  /** Nothing left to do for the object; saved with the next batch. */
  async done(path: string, verified: boolean | undefined, targetRef?: string): Promise<void> {
    const head = verified === true ? "d1" : verified === false ? "d0" : "d?";
    this.items[keyOf(path)] =
      targetRef !== undefined && targetRef.length <= MAX_DONE_REF ? `${head}:${targetRef}` : head;
    this.pending++;
    if (this.pending >= FLUSH_EVERY || this.now() - this.lastFlush >= FLUSH_AFTER_MS) {
      await this.flush();
    }
  }

  /** Save the record into the cursor, next to whatever else the cursor holds. */
  async flush(): Promise<void> {
    const current = (await this.cursor.load()) ?? {};
    const stored: StoredProgress = { job: this.job, items: this.items };
    await this.cursor.save({ ...current, [RESTORE_PROGRESS_CURSOR_KEY]: stored });
    this.pending = 0;
    this.lastFlush = this.now();
  }
}

/** The note on an item an earlier attempt of the same job restored. */
export const RESTORED_BY_EARLIER_ATTEMPT = "restored by an earlier attempt of this job";
