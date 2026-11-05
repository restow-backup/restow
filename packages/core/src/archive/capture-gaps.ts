/**
 * Gaps of the archive capture (docs/ARCHIVE.md "Lücken der Erfassung", 0.5.0): mail a capture
 * way could not take in, recorded durably instead of a warning in the log. The worker keeps
 * them in `archive_capture_gaps` (apps/worker/src/archive-capture/gaps.ts); the capture code
 * here only reports through a {@link CaptureGapSink}.
 *
 *   - a failed attempt ({@link CaptureGapSink.failed}) counts; the way retries later (the
 *     next pass, the next backfill job) and gives up after {@link GAP_OPEN_AFTER_ATTEMPTS};
 *   - a way that cannot retry (a Graph message without a MIME export) gives up at once
 *     ({@link CaptureGapSink.gaveUp});
 *   - a gap that is taken in after all is {@link CaptureGapSink.resolved}.
 *
 * From the third attempt on (or given up) a gap is open: the stream is "incomplete", never
 * fine, and the capture alert `capture_gap` names it.
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

export interface CaptureGapSink {
  /** One more failed attempt; returns the attempts in a row so far, this one included. */
  failed(gap: CaptureGap): Promise<number>;
  /** Given up without (more) retries: the gap is open at once. */
  gaveUp(gap: CaptureGap): Promise<void>;
  /** Taken in after all (read, or captured): a gap of `ref` is resolved. No-op without one. */
  resolved(kind: CaptureGapKind, ref: string): Promise<void>;
}

/** A gap as {@link MemoryCaptureGaps} holds it. */
export interface MemoryCaptureGap extends CaptureGap {
  attempts: number;
  open: boolean;
  resolved: boolean;
}

/** The gap sink of tests and of callers that keep nothing (the attempts live in memory). */
export class MemoryCaptureGaps implements CaptureGapSink {
  readonly gaps = new Map<string, MemoryCaptureGap>();

  private key(kind: CaptureGapKind, ref: string): string {
    return `${kind}:${ref}`;
  }

  async failed(gap: CaptureGap): Promise<number> {
    const key = this.key(gap.kind, gap.ref);
    const known = this.gaps.get(key);
    const attempts = known && !known.resolved ? known.attempts + 1 : 1;
    this.gaps.set(key, {
      ...gap,
      attempts,
      open: attempts >= GAP_OPEN_AFTER_ATTEMPTS,
      resolved: false,
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
    });
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
