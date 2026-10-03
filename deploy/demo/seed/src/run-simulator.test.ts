import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FinishRequest, ProgressRequest } from "./agent-api.js";
import type { AgentStateEntry } from "./agent-state.js";
import { ApiRequestError } from "./http-client.js";
import { mulberry32 } from "./prng.js";
import type { SimConfig } from "./run-sim.js";
import { RunSimulator, type SimAgentApi, type SimMachine, sleep } from "./run-simulator.js";

const SNAPSHOT = "b".repeat(64);

function entry(hostname: string, endpointId: string, tenant: string): AgentStateEntry {
  return {
    hostname,
    endpointId,
    agentSecret: "rsea_example",
    agentVersion: "0.2.0",
    osVersion: "Debian GNU/Linux 12 (bookworm)",
    configVersion: 1,
    profile: "server",
    schedule: { kind: "daily", timeOfDay: "22:00" },
    tenant,
    paths: ["/srv/share"],
    lastSnapshotId: SNAPSHOT,
  };
}

type Call =
  | { kind: "start" }
  | { kind: "progress"; runId: string; report: ProgressRequest }
  | { kind: "finish"; runId: string; request: FinishRequest };

function fakeApi(calls: Call[], options: { failStarts?: number } = {}): SimAgentApi {
  let runs = 0;
  let failStarts = options.failStarts ?? 0;
  return {
    async startRun() {
      if (failStarts > 0) {
        failStarts--;
        throw new ApiRequestError("POST", "/agent/v1/runs", 503, null);
      }
      calls.push({ kind: "start" });
      runs += 1;
      return `run-${runs}`;
    },
    async progress(runId, report) {
      calls.push({ kind: "progress", runId, report });
    },
    async finishRun(runId, request) {
      calls.push({ kind: "finish", runId, request });
    },
  };
}

const FAST: SimConfig = {
  enabled: true,
  intervalMs: 0,
  minDurationMs: 60,
  maxDurationMs: 60,
  progressMs: 20,
  partialRate: 0,
};

let dir = "";
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("RunSimulator", () => {
  it("starts a run, reports its progress and finishes it with the machine's snapshot", async () => {
    const calls: Call[] = [];
    const api = fakeApi(calls);
    const stop = new AbortController();
    const running: boolean[] = [];
    const machine: SimMachine = { entry: entry("fs", "e1", "t1"), api, quickApi: api };
    const simulator = new RunSimulator({
      machines: [machine],
      config: FAST,
      signal: stop.signal,
      log: () => {},
      rng: mulberry32(1),
      tickMs: 5,
      onRunning: (_, state) => running.push(state),
    });
    const done = simulator.run();
    for (let i = 0; i < 200 && !calls.some((call) => call.kind === "finish"); i++) {
      await sleep(10);
    }
    stop.abort();
    await done;

    const first = calls.findIndex((call) => call.kind === "finish");
    expect(calls[0]).toEqual({ kind: "start" });
    const progress = calls.slice(1, first);
    expect(progress.length).toBe(3);
    expect(progress.every((call) => call.kind === "progress" && call.runId === "run-1")).toBe(true);
    const finish = calls[first] as Extract<Call, { kind: "finish" }>;
    expect(finish.runId).toBe("run-1");
    expect(finish.request).toMatchObject({ status: "succeeded", snapshotId: SNAPSHOT });
    expect(running.slice(0, 2)).toEqual([true, false]);
  });

  it("closes a run in progress as interrupted when it is stopped", async () => {
    const calls: Call[] = [];
    const api = fakeApi(calls);
    const stop = new AbortController();
    const simulator = new RunSimulator({
      machines: [{ entry: entry("fs", "e1", "t1"), api, quickApi: api }],
      config: { ...FAST, minDurationMs: 60_000, maxDurationMs: 60_000 },
      signal: stop.signal,
      log: () => {},
      rng: mulberry32(1),
      tickMs: 5,
    });
    const done = simulator.run();
    for (let i = 0; i < 100 && !calls.some((call) => call.kind === "progress"); i++) {
      await sleep(10);
    }
    stop.abort();
    await done;
    const finishes = calls.filter((call) => call.kind === "finish");
    expect(finishes).toHaveLength(1);
    expect((finishes[0] as Extract<Call, { kind: "finish" }>).request).toMatchObject({
      status: "failed",
      errors: [{ code: "interrupted" }],
    });
  });

  it("never runs two machines of one tenant at once", async () => {
    const calls: Array<Call & { host: string }> = [];
    const stop = new AbortController();
    let active = 0;
    let most = 0;
    const tracking = (host: string): SimAgentApi => {
      const inner = fakeApi([]);
      return {
        async startRun(request) {
          active += 1;
          most = Math.max(most, active);
          calls.push({ kind: "start", host });
          return inner.startRun(request);
        },
        progress: inner.progress,
        async finishRun(runId, request) {
          active -= 1;
          return inner.finishRun(runId, request);
        },
      };
    };
    const machines = ["a", "b"].map((host) => {
      const api = tracking(host);
      return { entry: entry(host, `e-${host}`, "same-tenant"), api, quickApi: api };
    });
    const simulator = new RunSimulator({
      machines,
      config: FAST,
      signal: stop.signal,
      log: () => {},
      rng: mulberry32(2),
      tickMs: 5,
    });
    const done = simulator.run();
    await sleep(400);
    stop.abort();
    await done;
    expect(calls.length).toBeGreaterThan(1);
    expect(most).toBe(1);
  });

  it("backs off while the API cannot start a run", async () => {
    const calls: Call[] = [];
    const api = fakeApi(calls, { failStarts: 1 });
    const stop = new AbortController();
    const logs: string[] = [];
    const simulator = new RunSimulator({
      machines: [{ entry: entry("fs", "e1", "t1"), api, quickApi: api }],
      config: FAST,
      signal: stop.signal,
      log: (line) => logs.push(line),
      rng: mulberry32(1),
      tickMs: 5,
    });
    const done = simulator.run();
    await sleep(300);
    stop.abort();
    await done;
    // The first start failed; the next try waits 5 s, longer than this test runs.
    expect(calls).toEqual([]);
    expect(logs.some((line) => line.includes("next try in 5 s"))).toBe(true);
  });

  it("closes a run a killed sidecar left behind, and keeps the journal of runs in flight", async () => {
    dir = mkdtempSync(join(tmpdir(), "restow-sim-"));
    const journal = join(dir, "runs.json");
    writeFileSync(journal, JSON.stringify({ e1: "old-run", gone: "other" }));
    const calls: Call[] = [];
    const api = fakeApi(calls);
    const stop = new AbortController();
    const simulator = new RunSimulator({
      machines: [{ entry: entry("fs", "e1", "t1"), api, quickApi: api }],
      config: { ...FAST, minDurationMs: 60_000, maxDurationMs: 60_000 },
      signal: stop.signal,
      log: () => {},
      rng: mulberry32(1),
      tickMs: 5,
      journalPath: journal,
    });
    const done = simulator.run();
    for (let i = 0; i < 100 && !calls.some((call) => call.kind === "progress"); i++) {
      await sleep(10);
    }
    expect(calls[0]).toMatchObject({
      kind: "finish",
      runId: "old-run",
      request: { status: "failed", errors: [{ code: "interrupted" }] },
    });
    expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual({ e1: "run-1" });
    stop.abort();
    await done;
    expect(() => readFileSync(journal, "utf8")).toThrow();
  });

  it("drops a run the server no longer has", async () => {
    const calls: Call[] = [];
    const stop = new AbortController();
    const api: SimAgentApi = {
      ...fakeApi(calls),
      async progress() {
        throw new ApiRequestError("POST", "/agent/v1/runs/run-1/progress", 404, null);
      },
    };
    const logs: string[] = [];
    const simulator = new RunSimulator({
      machines: [{ entry: entry("fs", "e1", "t1"), api, quickApi: api }],
      config: { ...FAST, intervalMs: 60_000 },
      signal: stop.signal,
      log: (line) => logs.push(line),
      rng: mulberry32(1),
      tickMs: 5,
    });
    const done = simulator.run();
    for (let i = 0; i < 100 && !logs.some((line) => line.includes("gone")); i++) {
      await sleep(10);
    }
    stop.abort();
    await done;
    expect(calls.filter((call) => call.kind === "finish")).toEqual([]);
  });
});
