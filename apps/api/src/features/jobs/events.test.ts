import { describe, expect, it } from "vitest";
import type { JobDto } from "./dto.js";
import {
  HEARTBEAT_INTERVAL_MS,
  JobChangeTracker,
  RECONNECT_MS,
  type SseMessage,
  type StreamIo,
  type StreamStep,
  endMessage,
  errorMessage,
  heartbeatDue,
  jobMessage,
  jobsMessage,
  runStreamLoop,
  singleJobStep,
  windowStart,
} from "./events.js";

const JOB_A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const JOB_B = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";

const PROGRESS = { total: 10, done: 1, failed: 0, bytes: 100, etaSeconds: 90, updatedAt: "x" };

function job(overrides: Partial<JobDto> = {}): JobDto {
  return {
    id: JOB_A,
    queue: "backup",
    status: "active",
    protectedObjectId: null,
    object: null,
    scheduleId: null,
    trigger: "manual",
    full: false,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    startedAt: "2026-01-01T10:00:01.000Z",
    completedAt: null,
    errorMessage: null,
    failure: null,
    itemCauses: [],
    progress: PROGRESS,
    phase: { name: "download", since: "2026-01-01T10:00:02.000Z" },
    throttle: null,
    cancellable: true,
    retryable: false,
    checkIncomplete: false,
    ...overrides,
  };
}

describe("message shaping", () => {
  it("sends the snapshot with a reconnect hint and each job with a resumable id", () => {
    const snapshot = jobsMessage([job()]);
    expect(snapshot.event).toBe("jobs");
    expect(snapshot.retry).toBe(RECONNECT_MS);
    expect(JSON.parse(snapshot.data)).toEqual({ items: [job()] });

    const update = jobMessage(job());
    expect(update).toEqual({
      event: "job",
      data: JSON.stringify(job()),
      id: `${JOB_A}:2026-01-01T10:00:00.000Z`,
    });
  });

  it("ends with the final status, or null for a job that vanished", () => {
    expect(JSON.parse(endMessage(JOB_A, job({ status: "failed" })).data)).toEqual({
      id: JOB_A,
      status: "failed",
    });
    expect(JSON.parse(endMessage(JOB_A, null).data)).toEqual({ id: JOB_A, status: null });
  });

  it("keeps error events generic", () => {
    const message = errorMessage();
    expect(message.event).toBe("error");
    expect(JSON.parse(message.data)).toEqual({
      title: "Job updates unavailable",
      retryInMs: RECONNECT_MS,
    });
  });
});

describe("JobChangeTracker", () => {
  it("reports new and changed jobs once and forgets jobs that left the window", () => {
    const tracker = new JobChangeTracker();
    expect(tracker.changes([job()])).toHaveLength(1);
    expect(tracker.changes([job()])).toEqual([]);

    const progressed = job({ progress: { ...PROGRESS, done: 2 } });
    expect(tracker.changes([progressed, job({ id: JOB_B })])).toEqual([
      progressed,
      job({ id: JOB_B }),
    ]);

    // JOB_A dropped out, then comes back: it is new again.
    expect(tracker.changes([job({ id: JOB_B })])).toEqual([]);
    expect(tracker.changes([progressed, job({ id: JOB_B })])).toEqual([progressed]);
  });

  it("treats primed jobs as already sent", () => {
    const tracker = new JobChangeTracker();
    tracker.prime([job(), job({ id: JOB_B })]);
    expect(tracker.changes([job(), job({ id: JOB_B })])).toEqual([]);
    const throttled = job({
      throttle: {
        status: 429,
        waitMs: 30_000,
        retryAfterMs: 30_000,
        until: "2026-01-01T10:01:00.000Z",
        waits: 1,
        totalWaitMs: 30_000,
      },
    });
    expect(tracker.changes([throttled, job({ id: JOB_B })])).toEqual([throttled]);
  });
});

describe("singleJobStep", () => {
  it("sends changes while the job runs", () => {
    const tracker = new JobChangeTracker();
    expect(singleJobStep(tracker, JOB_A, job())).toEqual({
      messages: [jobMessage(job())],
      done: false,
    });
    expect(singleJobStep(tracker, JOB_A, job())).toEqual({ messages: [], done: false });
  });

  it("sends the final state and ends once the job is finished", () => {
    const tracker = new JobChangeTracker();
    const done = job({ status: "completed", phase: null, cancellable: false });
    expect(singleJobStep(tracker, JOB_A, done)).toEqual({
      messages: [jobMessage(done), endMessage(JOB_A, done)],
      done: true,
    });
  });

  it("ends when the job no longer exists", () => {
    expect(singleJobStep(new JobChangeTracker(), JOB_A, null)).toEqual({
      messages: [endMessage(JOB_A, null)],
      done: true,
    });
  });
});

describe("timing helpers", () => {
  it("asks for a heartbeat after the interval of silence", () => {
    expect(heartbeatDue(0, HEARTBEAT_INTERVAL_MS - 1)).toBe(false);
    expect(heartbeatDue(0, HEARTBEAT_INTERVAL_MS)).toBe(true);
  });

  it("opens the live window one minute back by default", () => {
    expect(windowStart(new Date("2026-01-01T10:00:00.000Z")).toISOString()).toBe(
      "2026-01-01T09:59:00.000Z",
    );
  });
});

/** An in-memory transport with a virtual clock that advances on sleep. */
class FakeIo implements StreamIo {
  readonly written: (SseMessage | "heartbeat")[] = [];
  clock = 0;
  disconnected = false;

  async write(message: SseMessage) {
    this.written.push(message);
  }
  async heartbeat() {
    this.written.push("heartbeat");
  }
  async sleep(ms: number) {
    this.clock += ms;
  }
  gone() {
    return this.disconnected;
  }
  now() {
    return this.clock;
  }
}

describe("runStreamLoop", () => {
  const quiet: StreamStep = { messages: [], done: false };

  it("polls until the step is done", async () => {
    const io = new FakeIo();
    let polls = 0;
    await runStreamLoop(io, async () => {
      polls++;
      return polls < 3 ? quiet : { messages: [endMessage(JOB_A, null)], done: true };
    });
    expect(polls).toBe(3);
    expect(io.written).toEqual([endMessage(JOB_A, null)]);
  });

  it("keeps an idle connection alive and ends at the stream lifetime", async () => {
    const io = new FakeIo();
    let polls = 0;
    await runStreamLoop(
      io,
      async () => {
        polls++;
        return quiet;
      },
      { pollMs: 5000, maxMs: 60_000 },
    );
    expect(polls).toBe(12);
    // Silence of 15 s triggers a keep-alive: after polls at 15 s, 30 s and 45 s.
    expect(io.written.filter((entry) => entry === "heartbeat")).toHaveLength(3);
  });

  it("stops as soon as the client is gone", async () => {
    const io = new FakeIo();
    let polls = 0;
    await runStreamLoop(io, async () => {
      polls++;
      io.disconnected = polls === 2;
      return quiet;
    });
    expect(polls).toBe(2);
  });

  it("sends an error event and rethrows when a read fails", async () => {
    const io = new FakeIo();
    await expect(
      runStreamLoop(io, async () => {
        throw new Error("connection terminated");
      }),
    ).rejects.toThrow("connection terminated");
    expect(io.written).toEqual([errorMessage()]);
  });
});
