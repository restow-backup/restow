import { MAIN_HOST_QUEUES } from "@restow/core";
import { describe, expect, it, vi } from "vitest";
import {
  consumedHandlers,
  excludedQueues,
  idleWhileHeld,
  type NodeHold,
  startNodeWatch,
} from "./node-guard.js";

/**
 * A worker on a node of another host (node-guard.ts): the queues of the main host are not
 * consumed; a hold (a database newer than the image, an update to another release under way)
 * stops the work and keeps the node idle until it is gone.
 */

const held: NodeHold = { reason: "version_mismatch", applied: 81, shipped: 80, updateTo: null };
const version = (newer: boolean): NodeHold | null => (newer ? held : null);

describe("excluded queues", () => {
  it("reads RESTOW_WORKER_EXCLUDE_QUEUES and refuses unknown names", () => {
    expect([...excludedQueues({})]).toEqual([]);
    expect([...excludedQueues({ RESTOW_WORKER_EXCLUDE_QUEUES: "import, export" })]).toEqual([
      "import",
      "export",
    ]);
    expect(() => excludedQueues({ RESTOW_WORKER_EXCLUDE_QUEUES: "import,files" })).toThrow(
      /unknown queue: files/,
    );
  });

  it("does not consume the queues of the main host", () => {
    const handlers = [{ queue: "backup" }, { queue: "import" }, { queue: "restore" }];
    const excluded = excludedQueues({ RESTOW_WORKER_EXCLUDE_QUEUES: MAIN_HOST_QUEUES.join(",") });
    expect(consumedHandlers(handlers, excluded).map((handler) => handler.queue)).toEqual([
      "backup",
      "restore",
    ]);
    expect(consumedHandlers(handlers, new Set()).length).toBe(3);
  });
});

describe("the node's hold", () => {
  it("stops the work once the node is held", async () => {
    vi.useFakeTimers();
    try {
      const answers = [version(false), version(true)];
      const onHold = vi.fn();
      const stop = startNodeWatch({
        check: async () => (answers.length > 0 ? (answers.shift() ?? null) : held),
        onHold,
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(onHold).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onHold).toHaveBeenCalledTimes(1);
      expect(onHold).toHaveBeenCalledWith(held);
      await vi.advanceTimersByTimeAsync(5000);
      expect(onHold).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays idle, beating, while held, and ignores a failed check", async () => {
    const answers: (NodeHold | null | Error)[] = [version(true), new Error("down"), version(false)];
    const beat = vi.fn(async () => undefined);
    await idleWhileHeld({
      check: async () => {
        const next = answers.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next === undefined ? null : next;
      },
      beat,
      sleep: async () => undefined,
    });
    expect(beat).toHaveBeenCalledTimes(3);
    expect(answers).toEqual([]);
  });
});
