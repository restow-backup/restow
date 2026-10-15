import { type JobStartPauseState, NOT_PAUSED } from "@restow/db";
import { describe, expect, it } from "vitest";
import { JobPauseGate } from "./job-pause.js";

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return this;
  },
};

const PAUSED: JobStartPauseState = {
  paused: true,
  drain: false,
  mode: "wait",
  phase: "draining",
  version: "0.4.0",
};
const DRAIN: JobStartPauseState = { ...PAUSED, drain: true, mode: "drain" };

/** pg-boss as far as the gate uses it: which queues are consumed right now. */
function fakeBoss() {
  let next = 0;
  const consumed = new Map<string, string>();
  return {
    consumed,
    send: async () => "sent",
    work: async (queue: string, _options?: object, _handler?: unknown) => {
      const id = `w${++next}`;
      consumed.set(id, queue);
      return id;
    },
    offWork: async ({ id }: { id: string }) => {
      consumed.delete(id);
    },
    queues: () => [...consumed.values()].sort(),
  };
}

function gateWith(states: JobStartPauseState[], ungated: string[] = []) {
  let current = states[0] ?? NOT_PAUSED;
  const gate = new JobPauseGate({
    read: async () => current,
    logger: noopLogger as never,
    ungated: new Set(ungated),
  });
  return {
    gate,
    set(state: JobStartPauseState) {
      current = state;
    },
  };
}

describe("JobPauseGate", () => {
  it("consumes queues while nothing is paused, and passes other calls through", async () => {
    const boss = fakeBoss();
    const { gate } = gateWith([NOT_PAUSED]);
    const wrapped = gate.wrap(boss);
    await wrapped.work("backup", {}, () => undefined);
    expect(boss.queues()).toEqual(["backup"]);
    expect(await wrapped.send()).toBe("sent");
  });

  it("takes queues off while paused and puts them back when the pause lifts", async () => {
    const boss = fakeBoss();
    const { gate, set } = gateWith([NOT_PAUSED], ["file-share-finish"]);
    const wrapped = gate.wrap(boss);
    await wrapped.work("backup", {}, () => undefined);
    await wrapped.work("restore", {}, () => undefined);
    await wrapped.work("file-share-finish", {}, () => undefined);

    set(PAUSED);
    await gate.refresh();
    expect(gate.paused()).toBe(true);
    expect(boss.queues()).toEqual(["file-share-finish"]);

    set(NOT_PAUSED);
    await gate.refresh();
    expect(gate.paused()).toBe(false);
    expect(boss.queues()).toEqual(["backup", "file-share-finish", "restore"]);
  });

  it("does not consume a queue registered during a pause until it lifts", async () => {
    const boss = fakeBoss();
    const { gate, set } = gateWith([PAUSED]);
    const wrapped = gate.wrap(boss);
    await gate.refresh();
    expect(await wrapped.work("backup", {}, () => undefined)).toBe("paused:backup");
    expect(boss.queues()).toEqual([]);
    set(NOT_PAUSED);
    await gate.refresh();
    expect(boss.queues()).toEqual(["backup"]);
  });

  it("asks running jobs to stop when the drain starts, and new ones at once", async () => {
    const boss = fakeBoss();
    const { gate, set } = gateWith([PAUSED]);
    gate.wrap(boss);
    await gate.refresh();
    let stopped = 0;
    const unsubscribe = gate.subscribe(() => {
      stopped++;
    });
    expect(stopped).toBe(0);
    set(DRAIN);
    await gate.refresh();
    expect(stopped).toBe(1);
    // A job that starts while the drain is on stops right away.
    gate.subscribe(() => {
      stopped++;
    });
    expect(stopped).toBe(2);
    unsubscribe();
    expect(gate.draining()).toBe(true);
  });

  it("keeps the last state when the pause cannot be read", async () => {
    const boss = fakeBoss();
    let fail = false;
    const gate = new JobPauseGate({
      read: async () => {
        if (fail) {
          throw new Error("database gone");
        }
        return PAUSED;
      },
      logger: noopLogger as never,
    });
    gate.wrap(boss);
    await gate.refresh();
    fail = true;
    await gate.refresh();
    expect(gate.paused()).toBe(true);
  });
});
