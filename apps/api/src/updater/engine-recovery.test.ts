import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATE_START_LIMIT_MS } from "./engine.js";
import {
  type Harness,
  apiAt,
  createHarness,
  scheduleRequest,
  settle,
  waitForCall,
} from "./testing.js";

let h: Harness;
const all: Harness[] = [];

beforeEach(async () => {
  h = await createHarness();
  all.push(h);
});

afterEach(async () => {
  for (const harness of all.splice(0)) {
    await harness.cleanup();
  }
});

async function restart(): Promise<Harness> {
  const next = await h.restart();
  all.push(next);
  h = next;
  return next;
}

/** Leave the run hanging inside `stop`, as if the process had been killed there. */
function hangAt(
  harness: Harness,
  operation: "composeStop" | "pull" | "dumpDatabase" | "composeUp",
): void {
  harness.ops[operation] = () => {
    harness.ops.calls.push(operation);
    return new Promise<never>(() => undefined);
  };
}

describe("recovery after the updater restarted", () => {
  it("keeps a scheduled run and starts it at its time", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 300 }));
    const restarted = await restart();
    await restarted.engine.init();
    expect(restarted.engine.view().phase).toBe("scheduled");
    expect(restarted.clock.pendingTimers).toBe(1);

    restarted.clock.advance(299_000);
    expect(restarted.engine.view().phase).toBe("scheduled");
    restarted.clock.advance(1000);
    await settle(restarted.engine);
    expect(restarted.engine.view().run?.outcome).toBe("succeeded");
    // The release's digests and mode survived the restart inside the run context.
    expect(restarted.ops.callsTo("pull")).toHaveLength(2);
  });

  it("starts a run that is at most ten minutes overdue right away", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    // The old process is down while the time passes: its timer never fires.
    await h.engine.shutdown();
    h.clock.advance(60_000 + LATE_START_LIMIT_MS - 1000);
    const restarted = await h.restart();
    all.push(restarted);
    h = restarted;
    await restarted.engine.init();
    await settle(restarted.engine);
    expect(restarted.engine.view().run?.outcome).toBe("succeeded");
  });

  it("does not start a run that is more than ten minutes overdue: failed, unchanged, interrupted", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    await h.engine.shutdown();
    h.clock.advance(60_000 + LATE_START_LIMIT_MS + 1000);
    const restarted = await restart();
    await restarted.engine.init();
    const view = restarted.engine.view();
    expect(view.phase).toBe("failed");
    expect(view.run).toMatchObject({
      outcome: "unchanged",
      failure: { code: "interrupted", step: "prepare" },
    });
    expect(view.run?.steps.every((step) => step.status === "skipped")).toBe(true);
    expect(restarted.ops.callsTo("pull")).toEqual([]);
    expect(view.history[0]?.id).toBe(view.run?.id);
    expect(view.events.map((event) => event.action)).toEqual(["update.failed"]);
    expect(view.events[0]?.details).toMatchObject({
      failureCode: "interrupted",
      outcome: "unchanged",
    });
  });

  it("a run interrupted before the workers were stopped ends unchanged", async () => {
    hangAt(h, "pull");
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await waitForCall(h, "pull");
    expect(h.engine.view().phase).toBe("running");
    const restarted = await restart();
    await restarted.engine.init();
    const view = restarted.engine.view();
    expect(view.phase).toBe("failed");
    expect(view.run).toMatchObject({
      outcome: "unchanged",
      failure: { code: "interrupted", step: "fetch" },
      message: { code: "run.interrupted" },
    });
    expect(view.run?.recovery).toBeNull();
    expect(view.run?.steps.find((step) => step.id === "fetch")?.status).toBe("failed");
    expect(view.history).toHaveLength(1);
  });

  it("a run interrupted while the workers were stopped needs attention and names the dump", async () => {
    hangAt(h, "composeStop");
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await waitForCall(h, "composeStop");
    expect(h.engine.view().run?.step).toBe("stop");
    const dump = (await h.dumps.list())[0];
    expect(dump).toBeDefined();
    const callsBefore = [...h.ops.calls];

    const restarted = await restart();
    await restarted.engine.init();
    const view = restarted.engine.view();
    expect(view.phase).toBe("failed");
    expect(view.run).toMatchObject({
      outcome: "needs_attention",
      failure: { code: "interrupted", step: "stop", migrationsRan: null },
    });
    expect(view.run?.recovery).toEqual({
      dumpFile: dump?.file,
      dumpBytes: dump?.bytes,
      fromVersion: "0.1.0",
      previousImages: {
        app: "ghcr.io/restow-backup/restow:0.1.0",
        web: "ghcr.io/restow-backup/restow-web:0.1.0",
      },
    });
    // Nothing is decided on the operator's behalf: no command ran on restart.
    expect(restarted.ops.calls).toEqual(callsBefore);
    expect(view.events.map((event) => event.action)).toEqual(["update.started", "update.failed"]);
  });

  it("a run interrupted during the start step needs attention", async () => {
    hangAt(h, "composeUp");
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await waitForCall(h, "composeUp");
    expect(h.engine.view().run?.step).toBe("start");
    const restarted = await restart();
    await restarted.engine.init();
    const run = restarted.engine.view().run;
    expect(run?.outcome).toBe("needs_attention");
    expect(run?.recovery?.dumpFile).toMatch(/\.dump$/);
    // The exact previous .env lines were persisted before .env was touched.
    const raw = JSON.parse(await fs.readFile(`${restarted.stateDir}/status.json`, "utf8")) as {
      runContext: { previousEnv: Record<string, { line: string | null }> };
    };
    expect(raw.runContext.previousEnv.RESTOW_IMAGE?.line).toBe(
      "RESTOW_IMAGE=ghcr.io/restow-backup/restow:0.1.0",
    );
  });

  it("a finished run stays readable after a restart and can be acknowledged", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await settle(h.engine);
    const restarted = await restart();
    await restarted.engine.init();
    const view = restarted.engine.view();
    expect(view.phase).toBe("succeeded");
    expect(view.run?.outcome).toBe("succeeded");
    expect(view.events.map((event) => event.action)).toEqual([
      "update.started",
      "update.succeeded",
    ]);
    await restarted.engine.acknowledge();
    expect(restarted.engine.view().phase).toBe("idle");
    expect(restarted.engine.view().history).toHaveLength(1);
  });

  it("continues journal ids across restarts", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await settle(h.engine);
    const before = h.engine.view().events.map((event) => event.id);
    const restarted = await restart();
    await restarted.engine.init();
    await restarted.engine.acknowledge();
    restarted.clock.advance(60_000);
    await restarted.engine.schedule(scheduleRequest("0.3.0"));
    await settle(restarted.engine);
    const after = restarted.engine.view().events.map((event) => event.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    expect([...after].sort()).toEqual(after);
    expect(new Set(after).size).toBe(after.length);
  });

  it("removes leftover sources on start", async () => {
    const restarted = await restart();
    await restarted.engine.init();
    expect(restarted.source.purges).toBe(1);
  });

  it("continues idle when status.json is corrupt and keeps the broken file", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await settle(h.engine);
    await h.store.flush();
    await fs.writeFile(`${h.stateDir}/status.json`, '{"schemaVersion":1,"phase":"runn');
    const restarted = await restart();
    await restarted.engine.init();
    const view = restarted.engine.view();
    expect(view.phase).toBe("idle");
    expect(view.run).toBeNull();
    expect(view.history).toEqual([]);
    expect(restarted.store.recoveredFrom).toMatch(/^status\.json\.corrupt-\d+$/);
    const names = await fs.readdir(restarted.stateDir);
    expect(names.filter((name) => name.startsWith("status.json.corrupt-"))).toHaveLength(1);
    expect(
      restarted.logger.lines.some(
        (line) => line.startsWith("ERROR") && line.includes("status.json"),
      ),
    ).toBe(true);
    // The updater keeps working.
    apiAt(restarted, "ghcr.io/restow-backup/restow:0.3.0", {
      kind: "ready",
      reportsVersion: "0.3.0",
    });
    await restarted.engine.schedule(scheduleRequest("0.3.0"));
    await settle(restarted.engine);
    expect(restarted.engine.view().run?.outcome).toBe("succeeded");
  });
});
