import { describe, expect, it } from "vitest";
import { ReadWriteGate } from "./gate.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ReadWriteGate", () => {
  it("lets shared holders overlap and makes the exclusive holder wait for them", async () => {
    const gate = new ReadWriteGate();
    const events: string[] = [];
    const releaseA = deferred();
    const releaseB = deferred();

    const a = gate.shared(async () => {
      events.push("a:start");
      await releaseA.promise;
      events.push("a:end");
    });
    const b = gate.shared(async () => {
      events.push("b:start");
      await releaseB.promise;
      events.push("b:end");
    });
    await Promise.resolve();
    const x = gate.exclusive(async () => {
      events.push("x");
    });
    await Promise.resolve();
    expect(events).toEqual(["a:start", "b:start"]);

    releaseA.resolve();
    await a;
    expect(events).not.toContain("x");
    releaseB.resolve();
    await Promise.all([b, x]);
    expect(events).toEqual(["a:start", "b:start", "a:end", "b:end", "x"]);
  });

  it("holds back new shared holders while an exclusive request is pending, then releases them together", async () => {
    const gate = new ReadWriteGate();
    const events: string[] = [];
    const releaseA = deferred();
    const releaseX = deferred();

    const a = gate.shared(async () => {
      await releaseA.promise;
      events.push("a");
    });
    await Promise.resolve();
    const x = gate.exclusive(async () => {
      events.push("x:start");
      await releaseX.promise;
      events.push("x:end");
    });
    const c = gate.shared(async () => {
      events.push("c");
    });
    await Promise.resolve();
    expect(events).toEqual([]);

    releaseA.resolve();
    await a;
    await Promise.resolve();
    expect(events).toEqual(["a", "x:start"]);
    releaseX.resolve();
    await Promise.all([x, c]);
    expect(events).toEqual(["a", "x:start", "x:end", "c"]);
  });

  it("serialises exclusive holders and propagates errors without deadlocking", async () => {
    const gate = new ReadWriteGate();
    await expect(
      gate.exclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const order: number[] = [];
    await Promise.all([
      gate.exclusive(async () => {
        order.push(1);
      }),
      gate.exclusive(async () => {
        order.push(2);
      }),
      gate.shared(async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });
});
