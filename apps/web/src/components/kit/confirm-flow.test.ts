import { describe, expect, it } from "vitest";

import { type ConfirmEffects, isPromiseLike, runConfirm } from "./confirm-flow.js";

/** Effects that record every call in order. */
function recorder() {
  const calls: string[] = [];
  const effects: ConfirmEffects = {
    setRunning: (running) => calls.push(`running:${running}`),
    setFailure: (cause) =>
      calls.push(cause === null ? "failure:none" : `failure:${(cause as Error).message}`),
    close: () => calls.push("close"),
  };
  return { calls, effects };
}

describe("runConfirm", () => {
  it("runs a promise to the end, then closes", async () => {
    const { calls, effects } = recorder();
    let finish: () => void = () => {};
    const action = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });

    const outcome = runConfirm(action, false, effects);
    // Pending while the action runs: busy, not closed.
    expect(calls).toEqual(["failure:none", "running:true"]);

    finish();
    expect(await outcome).toBe("closed");
    expect(calls).toEqual(["failure:none", "running:true", "running:false", "close"]);
  });

  it("closes a controlled dialog too once its promise resolved", async () => {
    const { calls, effects } = recorder();
    expect(await runConfirm(() => Promise.resolve(), true, effects)).toBe("closed");
    expect(calls.at(-1)).toBe("close");
  });

  it("stays open with the cause when the promise rejects", async () => {
    const { calls, effects } = recorder();
    const outcome = await runConfirm(
      () => Promise.reject(new Error("target in use")),
      false,
      effects,
    );
    expect(outcome).toBe("failed");
    expect(calls).toEqual([
      "failure:none",
      "running:true",
      "running:false",
      "failure:target in use",
    ]);
    expect(calls).not.toContain("close");
  });

  it("closes an uncontrolled dialog at once when the action is not a promise", async () => {
    const { calls, effects } = recorder();
    let ran = 0;
    const outcome = await runConfirm(
      () => {
        ran += 1;
      },
      false,
      effects,
    );
    expect(ran).toBe(1);
    expect(outcome).toBe("closed");
    expect(calls).toEqual(["failure:none", "close"]);
  });

  it("leaves a controlled dialog to its owner when the action is not a promise", async () => {
    const { calls, effects } = recorder();
    expect(await runConfirm(() => undefined, true, effects)).toBe("handedOver");
    expect(calls).toEqual(["failure:none"]);
  });

  it("treats an action that throws right away as a failure", async () => {
    const { calls, effects } = recorder();
    const outcome = await runConfirm(
      () => {
        throw new Error("not allowed");
      },
      false,
      effects,
    );
    expect(outcome).toBe("failed");
    expect(calls).toEqual(["failure:none", "failure:not allowed"]);
  });

  it("clears the previous failure before a new attempt", async () => {
    const { calls, effects } = recorder();
    await runConfirm(() => Promise.reject(new Error("first")), false, effects);
    calls.length = 0;
    await runConfirm(() => Promise.resolve(), false, effects);
    expect(calls[0]).toBe("failure:none");
  });
});

describe("isPromiseLike", () => {
  it("recognises promises only", () => {
    expect(isPromiseLike(Promise.resolve())).toBe(true);
    expect(isPromiseLike(undefined)).toBe(false);
    expect(isPromiseLike({})).toBe(false);
    expect(isPromiseLike("then")).toBe(false);
  });
});
