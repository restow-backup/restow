/**
 * Gaps of the archive capture (docs/ARCHIVE.md "Lücken der Erfassung", 0.5.0): mail a capture
 * way could not take in, recorded durably instead of a warning in the log. The worker keeps
 * them in `archive_capture_gaps` (apps/worker/src/archive-capture/gaps.ts); the capture code
 * here only reports through a {@link CaptureGapSink}.
 *
 *   - a failed attempt ({@link CaptureGapSink.failed}) counts; the way retries later (the
 *     next pass, the next backfill job) and gives up after {@link GAP_OPEN_AFTER_ATTEMPTS}.
 *     Attempts count at most once per {@link GAP_ATTEMPT_SPACING_MS}: passes run minutes
 *     apart, and a server that refuses for a quarter of an hour (a 5xx burst, a throttled
 *     folder) must not use up every attempt of mail that is fetchable again shortly after;
 *   - a way that cannot retry (a Graph message without a MIME export) gives up at once
 *     ({@link CaptureGapSink.gaveUp});
 *   - a gap that is taken in after all is {@link CaptureGapSink.resolved}.
 *
 * From the third attempt on (or given up) a gap is open: the stream is "incomplete", never
 * fine, and the capture alert `capture_gap` names it. An open gap is not the end: the ways
 * ask again for those that may succeed later ({@link CaptureGapSink.retryDue}, once per
 * {@link GAP_RETRY_AFTER_MS}): a refused or undelivered IMAP message, a folder the backfill
 * could not take over, a Graph message whose export or fetch failed. A message too large or
 * not convertible for a MIME export is not asked for again; no retry would change that.
 */

/**
 * What a gap is about:
 *
 *   - `folder`: a whole folder the live capture could not read (IMAP path);
 *   - `backfill_folder`: the mail a folder held when live capture started (the UIDs up to its
 *     `backfillUpTo`, IMAP path), which only the backfill takes over. Kept apart from `folder`:
 *     a live pass that reads the folder's new mail (or only its STATUS) says nothing about
 *     that older mail, so it neither counts nor resolves this gap. Only a takeover of the
 *     older mail resolves it (the backfill, or a live pass that reads the folder from its
 *     first UID: a resync);
 *   - `message`: one message (IMAP `<folder>;<uidvalidity>;<uid>`, Graph immutable id).
 */
export type CaptureGapKind = "folder" | "backfill_folder" | "message";

export interface CaptureGap {
  readonly kind: CaptureGapKind;
  readonly ref: string;
  /**
   * Why: a failure code of the catalog (`imap.server_limit`) or the way's own
   * (`undelivered`, `too_large`, `not_convertible`, `export_failed`, `fetch_failed`).
   */
  readonly reason: string;
}

/** Attempts after which a way gives up on a folder or a message and the gap is open. */
export const GAP_OPEN_AFTER_ATTEMPTS = 3;

/**
 * A failed attempt counts only when the last counted one is at least this long ago, so a gap
 * opens after two hours of failures at the earliest, however often the passes run.
 */
export const GAP_ATTEMPT_SPACING_MS = 60 * 60_000;

/** An open gap a way can retry is asked for again once per this long. */
export const GAP_RETRY_AFTER_MS = 24 * 60 * 60_000;

/** At most this many open gaps are asked for again per pass. */
export const GAP_RETRY_BATCH = 200;

export interface CaptureGapSink {
  /**
   * A failed attempt; returns the attempts counted so far, this one included when it counts
   * (at most one per {@link GAP_ATTEMPT_SPACING_MS}).
   */
  failed(gap: CaptureGap): Promise<number>;
  /** Given up without (more) retries: the gap is open at once. */
  gaveUp(gap: CaptureGap): Promise<void>;
  /** Taken in after all (read, or captured): a gap of `ref` is resolved. No-op without one. */
  resolved(kind: CaptureGapKind, ref: string): Promise<void>;
  /**
   * Open gaps of these kinds (and reasons, when given) not tried for
   * {@link GAP_RETRY_AFTER_MS}, at most {@link GAP_RETRY_BATCH}: marked as tried now and
   * returned, for the way to ask for once more. A sink without it retries nothing.
   */
  retryDue?(query: {
    readonly kinds: readonly CaptureGapKind[];
    readonly reasons?: readonly string[];
  }): Promise<CaptureGap[]>;
}

/** A gap as {@link MemoryCaptureGaps} holds it. */
export interface MemoryCaptureGap extends CaptureGap {
  attempts: number;
  open: boolean;
  resolved: boolean;
  /** When the last attempt counted, or the gap was last asked for again (epoch ms). */
  lastAttemptAt: number;
}

/** The gap sink of tests and of callers that keep nothing (the attempts live in memory). */
export class MemoryCaptureGaps implements CaptureGapSink {
  readonly gaps = new Map<string, MemoryCaptureGap>();
  private readonly now: () => number;
  private readonly spacingMs: number;

  constructor(options: { readonly now?: () => number; readonly spacingMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.spacingMs = options.spacingMs ?? GAP_ATTEMPT_SPACING_MS;
  }

  private key(kind: CaptureGapKind, ref: string): string {
    return `${kind}:${ref}`;
  }

  async failed(gap: CaptureGap): Promise<number> {
    const key = this.key(gap.kind, gap.ref);
    const known = this.gaps.get(key);
    const now = this.now();
    if (known && !known.resolved && now - known.lastAttemptAt < this.spacingMs) {
      return known.attempts;
    }
    const attempts = known && !known.resolved ? known.attempts + 1 : 1;
    this.gaps.set(key, {
      ...gap,
      attempts,
      open:
        (known !== undefined && !known.resolved && known.open) ||
        attempts >= GAP_OPEN_AFTER_ATTEMPTS,
      resolved: false,
      lastAttemptAt: now,
    });
    return attempts;
  }

  async gaveUp(gap: CaptureGap): Promise<void> {
    const key = this.key(gap.kind, gap.ref);
    const known = this.gaps.get(key);
    this.gaps.set(key, {
      ...gap,
      attempts: Math.max(GAP_OPEN_AFTER_ATTEMPTS, known && !known.resolved ? known.attempts : 0),
      open: true,
      resolved: false,
      lastAttemptAt: this.now(),
    });
  }

  async retryDue(query: {
    readonly kinds: readonly CaptureGapKind[];
    readonly reasons?: readonly string[];
  }): Promise<CaptureGap[]> {
    const now = this.now();
    const due: CaptureGap[] = [];
    for (const gap of this.gaps.values()) {
      if (
        due.length < GAP_RETRY_BATCH &&
        gap.open &&
        !gap.resolved &&
        query.kinds.includes(gap.kind) &&
        (query.reasons === undefined || query.reasons.includes(gap.reason)) &&
        now - gap.lastAttemptAt >= GAP_RETRY_AFTER_MS
      ) {
        gap.lastAttemptAt = now;
        due.push({ kind: gap.kind, ref: gap.ref, reason: gap.reason });
      }
    }
    return due;
  }

  async resolved(kind: CaptureGapKind, ref: string): Promise<void> {
    const known = this.gaps.get(this.key(kind, ref));
    if (known && !known.resolved) {
      known.resolved = true;
      known.open = false;
    }
  }

  /** The open gaps, as `kind:ref`. */
  open(): string[] {
    return [...this.gaps.entries()]
      .filter(([, gap]) => gap.open && !gap.resolved)
      .map(([key]) => key)
      .sort();
  }
}
