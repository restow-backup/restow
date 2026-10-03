import { describe, expect, it } from "vitest";
import type { JobDto } from "../jobs/dto.js";
import { POLL_INTERVAL_MS, type SseMessage, runStreamLoop } from "../jobs/events.js";
import type { RunDto } from "./dto.js";
import {
  type BackupJobLiveDto,
  DEFINITIONS_EVERY,
  KeyedTracker,
  type LiveSources,
  MACHINES_EVERY,
  type MachineLiveDto,
  createLiveStep,
  liveWindowStart,
} from "./live.js";

function run(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run-1",
    source: "mail",
    kind: "backup",
    type: "backup",
    state: "running",
    checkIncomplete: false,
    attempt: null,
    subject: null,
    job: null,
    trigger: "scheduled",
    full: false,
    createdAt: "2026-10-02T10:00:00.000Z",
    startedAt: "2026-10-02T10:00:01.000Z",
    finishedAt: null,
    updatedAt: "2026-10-02T10:00:02.000Z",
    progress: null,
    throughput: null,
    samples: null,
    phase: null,
    throttle: null,
    errorMessage: null,
    failure: null,
    cancellable: true,
    ...overrides,
  };
}

function legacy(id: string, status: JobDto["status"] = "active"): JobDto {
  return { id, status, updatedAt: "2026-10-02T10:00:02.000Z" } as JobDto;
}

function definition(overrides: Partial<BackupJobLiveDto> = {}): BackupJobLiveDto {
  return {
    id: "job-1",
    kind: "mail",
    enabled: true,
    state: "ok",
    scope: { count: 2, byKind: { mailbox: 2 }, overrides: 0 },
    lastRun: { at: null, failed: 0, partial: 0, running: 0, queued: 0, runId: null },
    nextRunAt: "2026-10-02T12:00:00.000Z",
    restoreCheck: {
      passed: 0,
      warning: 0,
      failed: 0,
      unverified: 0,
      noBackup: 2,
      total: 2,
      checkedAt: null,
    },
    updatedAt: "2026-10-02T09:00:00.000Z",
    ...overrides,
  };
}

function machine(overrides: Partial<MachineLiveDto> = {}): MachineLiveDto {
  return {
    id: "m1",
    status: "active",
    connection: "online",
    agentState: "idle",
    lastSeenAt: "2026-10-02T10:00:00.000Z",
    lastBackupAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    ...overrides,
  };
}

/** Sources whose answers a test changes between polls, counting how often each was read. */
function sources(initial: {
  runs?: RunDto[];
  jobs?: JobDto[];
  definitions?: BackupJobLiveDto[];
  machines?: MachineLiveDto[];
}) {
  const state = {
    runs: initial.runs ?? [],
    jobs: initial.jobs ?? [],
    definitions: initial.definitions ?? [],
    machines: initial.machines ?? [],
  };
  const reads = { runs: 0, definitions: 0, machines: 0 };
  const live: LiveSources = {
    runs: async () => {
      reads.runs++;
      return { runs: state.runs, jobs: state.jobs };
    },
    definitions: async () => {
      reads.definitions++;
      return state.definitions;
    },
    machines: async () => {
      reads.machines++;
      return state.machines;
    },
  };
  return { state, reads, live };
}

const names = (messages: readonly SseMessage[]) => messages.map((message) => message.event);

describe("KeyedTracker", () => {
  it("reports what is new or different once, and what is gone", () => {
    const tracker = new KeyedTracker<{ id: string; n: number }>((item) => item.id);
    tracker.prime([
      { id: "a", n: 1 },
      { id: "b", n: 1 },
    ]);
    expect(
      tracker.changes([
        { id: "a", n: 1 },
        { id: "b", n: 1 },
      ]),
    ).toEqual({
      changed: [],
      gone: [],
    });
    expect(
      tracker.changes([
        { id: "a", n: 2 },
        { id: "c", n: 1 },
      ]),
    ).toEqual({
      changed: [
        { id: "a", n: 2 },
        { id: "c", n: 1 },
      ],
      gone: ["b"],
    });
    // The second look at the same state is silent, and a forgotten id is not gone twice.
    expect(
      tracker.changes([
        { id: "a", n: 2 },
        { id: "c", n: 1 },
      ]),
    ).toEqual({
      changed: [],
      gone: [],
    });
  });
});

describe("the live step", () => {
  it("opens with one snapshot of runs, backup jobs and machines, and the legacy jobs event", async () => {
    const { live } = sources({
      runs: [run()],
      jobs: [legacy("run-1")],
      definitions: [definition()],
      machines: [machine()],
    });
    const step = createLiveStep(live, { now: () => new Date("2026-10-02T10:00:03.000Z") });
    const first = await step();
    expect(first.done).toBe(false);
    expect(names(first.messages)).toEqual(["snapshot", "jobs"]);
    const snapshot = JSON.parse(first.messages[0]?.data ?? "{}");
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.definitions).toHaveLength(1);
    expect(snapshot.machines).toHaveLength(1);
    expect(snapshot.serverTime).toBe("2026-10-02T10:00:03.000Z");
    // The browser is told how long to wait before it reconnects.
    expect(first.messages[0]?.retry).toBeGreaterThan(0);
    expect(JSON.parse(first.messages[1]?.data ?? "{}").items).toHaveLength(1);
  });

  it("sends nothing while nothing changed, and only the run that did", async () => {
    const s = sources({
      runs: [run({ id: "a" }), run({ id: "b" })],
      jobs: [legacy("a"), legacy("b")],
    });
    const step = createLiveStep(s.live);
    await step();
    expect((await step()).messages).toEqual([]);
    s.state.runs = [
      run({ id: "a" }),
      run({
        id: "b",
        updatedAt: "2026-10-02T10:00:04.000Z",
        throughput: { processedBps: 5, transferredBps: 1 },
      }),
    ];
    const next = await step();
    expect(names(next.messages)).toEqual(["run"]);
    expect(JSON.parse(next.messages[0]?.data ?? "{}").id).toBe("b");
    // The event id names the run and its marker, so a reconnecting browser can tell where it was.
    expect(next.messages[0]?.id).toBe("b:2026-10-02T10:00:04.000Z");
  });

  it("also sends a changed mail run in the legacy shape the older pages read", async () => {
    const s = sources({ runs: [run({ id: "a" })], jobs: [legacy("a")] });
    const step = createLiveStep(s.live);
    await step();
    s.state.runs = [run({ id: "a", updatedAt: "2026-10-02T10:00:09.000Z" })];
    s.state.jobs = [legacy("a", "completed")];
    expect(names((await step()).messages)).toEqual(["run", "job"]);
  });

  it("reads machines and definitions on their own slower cadence", async () => {
    const s = sources({ definitions: [definition()], machines: [machine()] });
    const step = createLiveStep(s.live);
    await step(); // poll 0: the snapshot reads everything once
    const polls = DEFINITIONS_EVERY * MACHINES_EVERY;
    for (let tick = 1; tick < polls; tick++) {
      await step();
    }
    // Runs every poll; machines every MACHINES_EVERY-th, definitions every DEFINITIONS_EVERY-th.
    expect(s.reads.runs).toBe(polls);
    expect(s.reads.machines).toBe(1 + Math.floor((polls - 1) / MACHINES_EVERY));
    expect(s.reads.definitions).toBe(1 + Math.floor((polls - 1) / DEFINITIONS_EVERY));
  });

  it("announces a machine that changed its connection state, and one that is gone", async () => {
    const s = sources({ machines: [machine({ id: "m1" }), machine({ id: "m2" })] });
    const step = createLiveStep(s.live);
    await step();
    s.state.machines = [machine({ id: "m1", connection: "offline", agentState: null })];
    let seen: SseMessage[] = [];
    for (let tick = 1; tick <= MACHINES_EVERY && seen.length === 0; tick++) {
      seen = [...(await step()).messages];
    }
    expect(names(seen)).toEqual(["machine", "gone"]);
    expect(JSON.parse(seen[0]?.data ?? "{}")).toMatchObject({ id: "m1", connection: "offline" });
    expect(JSON.parse(seen[1]?.data ?? "{}")).toEqual({ kind: "machine", id: "m2" });
  });

  it("re-reads the backup jobs right after a run changed its state", async () => {
    const s = sources({
      runs: [run({ id: "a", state: "running" })],
      jobs: [legacy("a")],
      definitions: [
        definition({
          lastRun: { at: null, failed: 0, partial: 0, running: 1, queued: 0, runId: "a" },
        }),
      ],
    });
    const step = createLiveStep(s.live);
    await step();
    const before = s.reads.definitions;
    // A progress update changes no state: no extra read of the definitions.
    s.state.runs = [run({ id: "a", updatedAt: "2026-10-02T10:00:04.000Z" })];
    await step();
    expect(s.reads.definitions).toBe(before);
    // The run finishes: the job's "last run" has moved, and the stream says so in the same poll.
    s.state.runs = [run({ id: "a", state: "succeeded", updatedAt: "2026-10-02T10:00:06.000Z" })];
    s.state.definitions = [
      definition({
        lastRun: {
          at: "2026-10-02T10:00:06.000Z",
          failed: 0,
          partial: 0,
          running: 0,
          queued: 0,
          runId: "a",
        },
      }),
    ];
    const done = await step();
    expect(names(done.messages)).toContain("run");
    expect(names(done.messages)).toContain("definition");
    expect(s.reads.definitions).toBe(before + 1);
  });

  it("drops a run from the window silently: finishing is news, ageing out is not", async () => {
    const s = sources({ runs: [run({ id: "a", state: "succeeded" })] });
    const step = createLiveStep(s.live);
    await step();
    s.state.runs = [];
    expect((await step()).messages).toEqual([]);
  });
});

describe("the stream over the loop", () => {
  it("polls every two seconds, keeps the connection alive and ends when the client leaves", async () => {
    const s = sources({ runs: [run()], jobs: [legacy("run-1")] });
    const written: SseMessage[] = [];
    const sleeps: number[] = [];
    let clock = 0;
    let beats = 0;
    let polls = 0;
    const step = createLiveStep(s.live);
    await runStreamLoop(
      {
        write: async (message) => {
          written.push(message);
        },
        heartbeat: async () => {
          beats++;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
          polls++;
        },
        gone: () => polls >= 9,
        now: () => clock,
      },
      step,
    );
    expect(names(written)).toEqual(["snapshot", "jobs"]);
    expect(new Set(sleeps)).toEqual(new Set([POLL_INTERVAL_MS]));
    // Silence of fifteen seconds draws one comment line.
    expect(beats).toBeGreaterThanOrEqual(1);
  });
});

describe("the live window", () => {
  it("opens a minute before the stream does", () => {
    const now = new Date("2026-10-02T10:05:00.000Z");
    expect(liveWindowStart(now).toISOString()).toBe("2026-10-02T10:04:00.000Z");
  });
});
