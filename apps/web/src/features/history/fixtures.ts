import type {
  Run,
  RunDetail,
  RunObject,
  RunRestoreCheck,
  RunState,
  SamplePoint,
  SubjectKind,
} from "./api";

/**
 * Runs for the tests of History, the drawer and the pages that show a run: a mail backup that is
 * running, one that finished and was checked, an agent run, a restore check that is on its third
 * attempt. Ids are real UUIDs, as the server's are: an address with anything else is not a run.
 */

export const RUN_IDS = {
  mailRunning: "11111111-1111-4111-8111-111111111111",
  mailDone: "22222222-2222-4222-8222-222222222222",
  agentRunning: "33333333-3333-4333-8333-333333333333",
  checkRetry: "44444444-4444-4444-8444-444444444444",
  agentDone: "55555555-5555-4555-8555-555555555555",
  jobMail: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  jobMachines: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  machine: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;

/** The clock of the fixtures. */
export const T0 = Date.parse("2026-10-02T10:00:00.000Z");
export const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

/** `count` measurements two seconds apart, counters growing at a steady speed. */
export function samples(
  count: number,
  options: { processedPerStep?: number; transferredPerStep?: number; start?: number } = {},
): SamplePoint[] {
  const { processedPerStep = 8_000_000, transferredPerStep = 400_000, start = T0 } = options;
  return Array.from(
    { length: count },
    (_, index): SamplePoint => [
      start + index * 2000,
      index * processedPerStep,
      index * transferredPerStep,
    ],
  );
}

export function subject(
  kind: SubjectKind = "mailbox",
  name = "anna@contoso.example",
): NonNullable<Run["subject"]> {
  return {
    kind,
    id: kind === "server" ? RUN_IDS.machine : "99999999-9999-4999-8999-999999999999",
    name,
    detail: null,
  };
}

export function run(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_IDS.mailRunning,
    source: "mail",
    kind: "backup",
    type: "backup",
    state: "running",
    checkIncomplete: false,
    attempt: null,
    subject: subject(),
    job: { id: RUN_IDS.jobMail, name: "Mail backup" },
    trigger: "scheduled",
    full: false,
    createdAt: iso(-5),
    startedAt: iso(0),
    finishedAt: null,
    updatedAt: iso(60),
    progress: {
      percent: 40,
      itemsDone: 400,
      itemsTotal: 1000,
      itemsFailed: 0,
      bytesProcessed: 320_000_000,
      bytesTransferred: 16_000_000,
      bytesNew: 40_000_000,
      bytesTotal: null,
      etaSeconds: 90,
      currentPath: null,
      updatedAt: iso(60),
    },
    throughput: { processedBps: 4_000_000, transferredBps: 200_000 },
    samples: samples(30),
    phase: { name: "download", since: iso(2) },
    throttle: null,
    errorMessage: null,
    failure: null,
    cancellable: true,
    ...overrides,
  };
}

export function finished(state: RunState = "succeeded", overrides: Partial<Run> = {}): Run {
  return run({
    id: RUN_IDS.mailDone,
    state,
    finishedAt: iso(600),
    updatedAt: iso(600),
    progress: {
      percent: 100,
      itemsDone: 1000,
      itemsTotal: 1000,
      itemsFailed: state === "partial" ? 3 : 0,
      bytesProcessed: 800_000_000,
      bytesTransferred: 40_000_000,
      bytesNew: 100_000_000,
      bytesTotal: null,
      etaSeconds: null,
      currentPath: null,
      updatedAt: iso(600),
    },
    throughput: null,
    samples: samples(60),
    phase: null,
    cancellable: false,
    ...overrides,
  });
}

export function agentRun(overrides: Partial<Run> = {}): Run {
  return run({
    id: RUN_IDS.agentRunning,
    source: "endpoint",
    subject: subject("server", "fs-bergisch"),
    job: { id: RUN_IDS.jobMachines, name: "Linux servers" },
    progress: {
      percent: 25,
      itemsDone: 2500,
      itemsTotal: 10_000,
      itemsFailed: 0,
      bytesProcessed: 2_000_000_000,
      bytesTransferred: 120_000_000,
      bytesNew: null,
      bytesTotal: 8_000_000_000,
      etaSeconds: 300,
      currentPath: "/srv/data/archive/2025.db",
      updatedAt: iso(60),
    },
    phase: null,
    cancellable: false,
    ...overrides,
  });
}

export function check(
  state: RunRestoreCheck["state"] = "passed",
  runId: string | null = RUN_IDS.mailDone,
): RunRestoreCheck {
  return { state, checkedAt: state === "passed" ? iso(660) : null, runId };
}

export function object(overrides: Partial<RunObject> = {}): RunObject {
  return {
    runId: RUN_IDS.mailDone,
    subject: subject(),
    state: "succeeded",
    restoreCheck: check("passed"),
    current: true,
    ...overrides,
  };
}

export function detail(base: Run = run(), overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    ...base,
    summary: {
      itemsWritten: 1000,
      itemsTotal: 1000,
      filesNew: null,
      filesChanged: null,
      bytesNew: 100_000_000,
      snapshot: { id: "snap", sequence: 7 },
      throttleWaits: 0,
      throttleWaitMs: 0,
    },
    restoreCheck: check("passed"),
    batch: {
      total: 3,
      queued: 0,
      running: 1,
      succeeded: 2,
      partial: 0,
      failed: 0,
      cancelled: 0,
      truncated: false,
    },
    objects: [
      object({ runId: base.id, current: true, state: base.state }),
      object({
        runId: "66666666-6666-4666-8666-666666666666",
        subject: subject("mailbox", "ben@contoso.example"),
        current: false,
        state: "running",
        restoreCheck: check("none", null),
      }),
      object({
        runId: "77777777-7777-4777-8777-777777777777",
        subject: subject("mailbox", "clara@contoso.example"),
        current: false,
        state: "succeeded",
        restoreCheck: check("queued", null),
      }),
    ],
    events: [
      { at: iso(-5), type: "queued", params: {}, durationMs: null },
      { at: iso(0), type: "started", params: { full: false }, durationMs: 5000 },
      { at: iso(2), type: "phase", params: { phase: "download" }, durationMs: 2000 },
    ],
    errors: [],
    errorCount: 0,
    logTail: null,
    docsUrl: "https://docs.restowbackup.com/troubleshooting",
    ...overrides,
  };
}
