import { describe, expect, it } from "vitest";
import { MemoryProgressSink } from "./memory.js";
import { type ProgressSink, ProgressTracker, type ProgressUpdate } from "./progress.js";

function clockAt(start = 1_000_000): { now: () => number; tick: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    tick: (ms) => {
      t += ms;
    },
  };
}

describe("ProgressTracker", () => {
  it("batches item updates by count", async () => {
    const sink = new MemoryProgressSink();
    const clock = clockAt();
    const tracker = new ProgressTracker({
      sink,
      flushEveryItems: 10,
      flushIntervalMs: 60_000,
      clock: clock.now,
    });
    tracker.total(100);
    for (let i = 0; i < 25; i++) {
      tracker.advance(1, 100);
      await Promise.resolve(); // let a scheduled flush complete before the next item
    }
    await tracker.flush();
    // 25 items with a batch of 10: two count-triggered flushes plus the final one.
    expect(sink.updates).toHaveLength(3);
    expect(sink.updates.map((u) => u.snapshot.done)).toEqual([10, 20, 25]);
    expect(sink.last?.snapshot).toMatchObject({ total: 100, done: 25, bytes: 2500, failed: 0 });
  });

  it("coalesces flush requests that arrive while one is in flight", async () => {
    const sink = new MemoryProgressSink();
    const tracker = new ProgressTracker({ sink, flushEveryItems: 10, flushIntervalMs: 60_000 });
    for (let i = 0; i < 25; i++) {
      tracker.advance(); // synchronous burst: the second batch boundary lands mid-flight
    }
    await tracker.flush();
    // The queued flush carries the latest counters instead of replaying each boundary.
    expect(sink.updates.map((u) => u.snapshot.done)).toEqual([10, 25]);
  });

  it("batches by time and flushes on phase changes", async () => {
    const sink = new MemoryProgressSink();
    const clock = clockAt();
    const tracker = new ProgressTracker({
      sink,
      flushEveryItems: 1000,
      flushIntervalMs: 1000,
      clock: clock.now,
    });
    tracker.advance();
    tracker.advance();
    expect(sink.updates).toHaveLength(0);
    clock.tick(1500);
    tracker.advance();
    await tracker.flush();
    expect(sink.updates).toHaveLength(1);
    expect(sink.last?.snapshot.done).toBe(3);

    tracker.phase("manifest");
    await tracker.flush();
    expect(sink.last?.snapshot.phase).toBe("manifest");
    tracker.phase("manifest"); // unchanged phase does not publish again
    await tracker.flush();
    expect(sink.updates).toHaveLength(2);
  });

  it("delivers each failure exactly once", async () => {
    const sink = new MemoryProgressSink();
    const tracker = new ProgressTracker({ sink, flushEveryItems: 2, flushIntervalMs: 60_000 });
    tracker.fail("item-1", "410 Gone");
    tracker.fail("item-2", "timeout");
    tracker.fail("item-3", "413 too large");
    await tracker.flush();
    expect(sink.failures.map((f) => f.itemRef)).toEqual(["item-1", "item-2", "item-3"]);
    expect(sink.last?.snapshot.failed).toBe(3);
    await tracker.flush();
    expect(sink.failures).toHaveLength(3);
  });

  it("never overlaps flushes and keeps failures when the sink rejects", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let failNext = true;
    const published: ProgressUpdate[] = [];
    const errors: unknown[] = [];
    const sink: ProgressSink = {
      async publish(update) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        if (failNext) {
          failNext = false;
          throw new Error("db down");
        }
        published.push(update);
      },
    };
    const tracker = new ProgressTracker({
      sink,
      flushEveryItems: 1,
      flushIntervalMs: 0,
      onError: (e) => errors.push(e),
    });
    tracker.fail("a", "x");
    tracker.fail("b", "y");
    tracker.advance();
    await tracker.flush();
    await tracker.flush();
    expect(maxInFlight).toBe(1);
    expect(errors).toHaveLength(1);
    const failures = published.flatMap((u) => u.failures.map((f) => f.itemRef));
    expect(failures.sort()).toEqual(["a", "b"]);
  });

  it("estimates the remaining time from the observed rate", async () => {
    const sink = new MemoryProgressSink();
    const clock = clockAt();
    const tracker = new ProgressTracker({ sink, clock: clock.now });
    expect(tracker.snapshot().etaSeconds).toBeNull();
    tracker.total(100);
    tracker.advance(10);
    clock.tick(10_000); // 10 items in 10 s -> 90 left -> 90 s
    expect(tracker.snapshot().etaSeconds).toBe(90);
  });

  it("counts what was processed apart from what was stored, and what was transferred", async () => {
    const sink = new MemoryProgressSink();
    const tracker = new ProgressTracker({ sink, flushEveryItems: 1000, flushIntervalMs: 60_000 });
    // An item of 1000 bytes of which 100 were new; the engine says so.
    tracker.advance(1, 100, 1000);
    // An engine that gives no processed count: it is what it stored.
    tracker.advance(1, 50);
    // An engine cannot have read less than it stored.
    tracker.advance(1, 40, 10);
    tracker.transfer(30);
    tracker.transfer(0);
    tracker.transfer(-5);
    await tracker.flush();
    expect(sink.last?.snapshot).toMatchObject({
      done: 3,
      bytes: 190,
      bytesProcessed: 1000 + 50 + 40,
      bytesTransferred: 30,
    });
  });

  it("carries a transfer to the sink even when no item follows", async () => {
    const sink = new MemoryProgressSink();
    const tracker = new ProgressTracker({ sink, flushEveryItems: 1000, flushIntervalMs: 60_000 });
    tracker.transfer(4096);
    await tracker.flush();
    expect(sink.last?.snapshot.bytesTransferred).toBe(4096);
  });
});
