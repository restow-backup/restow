/**
 * Progress tracking with batched persistence.
 *
 * Engines call `advance()` per item, which can be thousands of times a minute;
 * writing a row per call would turn Postgres into the bottleneck. The tracker
 * keeps the counters in memory and hands a snapshot (plus the failures gathered
 * since the last flush) to a {@link ProgressSink} when enough items or enough
 * time have accumulated, when the phase changes, and on an explicit flush().
 * Flushes never overlap; a flush requested while one is in flight runs right
 * after it. No timers are used, so a tracker can never keep a process alive.
 */
import type { FailureCause } from "../failures/types.js";
import type { ItemFailureRecord, ProgressReporter, ProgressSnapshot } from "./types.js";

export interface ProgressUpdate {
  readonly snapshot: ProgressSnapshot;
  /** Failures recorded since the previous update. */
  readonly failures: readonly ItemFailureRecord[];
}

export interface ProgressSink {
  publish(update: ProgressUpdate): Promise<void>;
}

export interface ProgressTrackerOptions {
  readonly sink: ProgressSink;
  /** Flush after this many advance()/fail() calls (default 50). */
  readonly flushEveryItems?: number;
  /** Flush when this much time has passed since the last flush (default 2000 ms). */
  readonly flushIntervalMs?: number;
  /** Millisecond clock, injectable for tests. */
  readonly clock?: () => number;
  /** Called when the sink rejects; the tracker keeps going (progress is best-effort). */
  readonly onError?: (error: unknown) => void;
}

export class ProgressTracker implements ProgressReporter {
  private totalCount = 0;
  private doneCount = 0;
  private failedCount = 0;
  private byteCount = 0;
  private currentPhase: string | null = null;
  private startedAt: number | null = null;

  private pendingFailures: ItemFailureRecord[] = [];
  private dirty = false;
  private itemsSinceFlush = 0;
  private lastFlushAt: number;
  private inFlight: Promise<void> | null = null;
  private queued = false;

  private readonly flushEveryItems: number;
  private readonly flushIntervalMs: number;
  private readonly clock: () => number;

  constructor(private readonly options: ProgressTrackerOptions) {
    this.flushEveryItems = Math.max(1, options.flushEveryItems ?? 50);
    this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? 2000);
    this.clock = options.clock ?? Date.now;
    this.lastFlushAt = this.clock();
  }

  total(count: number): void {
    if (count > this.totalCount) {
      this.totalCount = count;
      this.markDirty(0);
    }
  }

  advance(done = 1, bytes = 0): void {
    if (this.startedAt === null) {
      this.startedAt = this.clock();
    }
    this.doneCount += done;
    this.byteCount += bytes;
    this.markDirty(done);
  }

  fail(itemRef: string, reason: string, cause?: FailureCause): void {
    this.failedCount++;
    this.pendingFailures.push(cause ? { itemRef, reason, cause } : { itemRef, reason });
    this.markDirty(1);
  }

  phase(name: string): void {
    if (this.currentPhase === name) {
      return;
    }
    this.currentPhase = name;
    this.dirty = true;
    this.scheduleFlush();
  }

  snapshot(): ProgressSnapshot {
    return {
      total: this.totalCount,
      done: this.doneCount,
      failed: this.failedCount,
      bytes: this.byteCount,
      phase: this.currentPhase,
      etaSeconds: this.eta(),
    };
  }

  /** Persist pending state. Resolves once the sink has seen everything so far. */
  async flush(): Promise<void> {
    if (this.dirty || this.pendingFailures.length > 0) {
      this.scheduleFlush();
    }
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  private eta(): number | null {
    if (this.startedAt === null || this.totalCount <= 0 || this.doneCount <= 0) {
      return null;
    }
    const elapsedMs = this.clock() - this.startedAt;
    if (elapsedMs <= 0) {
      return null;
    }
    const remaining = Math.max(0, this.totalCount - this.doneCount - this.failedCount);
    const perMs = this.doneCount / elapsedMs;
    return Math.round(remaining / perMs / 1000);
  }

  private markDirty(items: number): void {
    this.dirty = true;
    this.itemsSinceFlush += items;
    const due =
      this.itemsSinceFlush >= this.flushEveryItems ||
      this.clock() - this.lastFlushAt >= this.flushIntervalMs;
    if (due) {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.inFlight = this.runFlush().finally(() => {
      this.inFlight = null;
      if (this.queued) {
        this.queued = false;
        this.scheduleFlush();
      }
    });
  }

  private async runFlush(): Promise<void> {
    const update: ProgressUpdate = { snapshot: this.snapshot(), failures: this.pendingFailures };
    this.pendingFailures = [];
    this.dirty = false;
    this.itemsSinceFlush = 0;
    this.lastFlushAt = this.clock();
    try {
      await this.options.sink.publish(update);
    } catch (error) {
      // Re-queue the failures so they are not lost; counters are cumulative anyway.
      this.pendingFailures = [...update.failures, ...this.pendingFailures];
      this.dirty = true;
      this.options.onError?.(error);
    }
  }
}
