import type { EndpointRun, Job, JobProgress } from "@restow/db";
import { samplePoint } from "@restow/db";
import { describe, expect, it } from "vitest";
import type { JobObjectDto } from "../jobs/dto.js";
import { toJobDto } from "../jobs/dto.js";
import {
  ENDPOINT_CHECK_ATTEMPTS,
  ENDPOINT_KINDS_OF_CATEGORY,
  LIST_SAMPLE_COUNT,
  MAIL_CHECK_ATTEMPTS,
  QUEUES_OF_CATEGORY,
  RUN_CATEGORIES,
  batchOf,
  categoryOfEndpointKind,
  categoryOfQueue,
  endpointCheckAttempt,
  endpointRun,
  isFinished,
  mailCheckAttempt,
  mailRun,
  stateOfEndpointRun,
  stateOfJob,
  timeline,
} from "./dto.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const JOB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OBJECT = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const AT = new Date("2026-10-02T10:00:00.000Z");

const mailbox: JobObjectDto = {
  id: OBJECT,
  sourceId: "5a1f0a52-7d0e-4c1b-9f3a-2b6c8d9e0f22",
  kind: "mailbox",
  displayName: "Alice",
  externalId: "alice@contoso.example",
  status: "active",
};

function jobRow(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB,
    tenantId: TENANT,
    queue: "backup",
    status: "active",
    protectedObjectId: OBJECT,
    payload: { jobId: JOB, tenantId: TENANT, protectedObjectId: OBJECT },
    cursor: null,
    pgBossJobId: "boss-1",
    errorMessage: null,
    failure: null,
    itemFailureSummary: null,
    startedAt: AT,
    completedAt: null,
    createdAt: new Date(AT.getTime() - 5000),
    updatedAt: AT,
    ...overrides,
  };
}

function progressRow(overrides: Partial<JobProgress> = {}): JobProgress {
  return {
    id: "1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a",
    tenantId: TENANT,
    jobId: JOB,
    total: 200,
    done: 50,
    failed: 0,
    bytes: 1_000,
    bytesProcessed: 9_000,
    bytesTransferred: 400,
    etaSeconds: 120,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function mail(
  job: Partial<Job> = {},
  progress: Partial<JobProgress> | null = {},
  samples: ReturnType<typeof samplePoint>[] = [],
) {
  const row = {
    job: jobRow(job),
    progress: progress === null ? null : progressRow(progress),
    object: mailbox,
  };
  return mailRun({ row, dto: toJobDto(row), job: null, samples });
}

describe("categories", () => {
  it("sorts every queue and every agent run kind into one History tab", () => {
    expect(categoryOfQueue("backup")).toBe("backup");
    expect(categoryOfQueue("restore")).toBe("restore");
    expect(categoryOfQueue("verify")).toBe("restore_check");
    expect(categoryOfQueue("export")).toBe("export");
    expect(categoryOfQueue("import")).toBe("import");
    for (const queue of [
      "archive",
      "directory",
      "retention",
      "scrub",
      "storage_migration",
    ] as const) {
      expect(categoryOfQueue(queue)).toBe("maintenance");
    }
    expect(categoryOfEndpointKind("backup")).toBe("backup");
    expect(categoryOfEndpointKind("restore")).toBe("restore");
    expect(categoryOfEndpointKind("verify_sample")).toBe("restore_check");
  });

  it("filters by the same grouping the other way round, without leaving any queue out", () => {
    const covered = RUN_CATEGORIES.flatMap((category) => QUEUES_OF_CATEGORY[category]);
    expect(new Set(covered).size).toBe(covered.length);
    for (const category of RUN_CATEGORIES) {
      for (const queue of QUEUES_OF_CATEGORY[category]) {
        expect(categoryOfQueue(queue)).toBe(category);
      }
      for (const kind of ENDPOINT_KINDS_OF_CATEGORY[category]) {
        expect(categoryOfEndpointKind(kind)).toBe(category);
      }
    }
    // Every queue the API knows has a tab.
    expect(covered.sort()).toEqual(
      [
        "archive",
        "backup",
        "directory",
        "export",
        "import",
        "restore",
        "retention",
        "scrub",
        "storage_migration",
        "verify",
      ].sort(),
    );
  });
});

describe("states", () => {
  it("speaks one vocabulary over both sources", () => {
    expect(stateOfJob("queued", 0)).toBe("queued");
    expect(stateOfJob("active", 0)).toBe("running");
    expect(stateOfJob("completed", 0)).toBe("succeeded");
    // Completed with items it could not process is the partial of an agent run.
    expect(stateOfJob("completed", 3)).toBe("partial");
    expect(stateOfJob("failed", 3)).toBe("failed");
    expect(stateOfJob("cancelled", 0)).toBe("cancelled");
    expect(stateOfEndpointRun("running")).toBe("running");
    expect(stateOfEndpointRun("succeeded")).toBe("succeeded");
    expect(stateOfEndpointRun("partial")).toBe("partial");
    expect(stateOfEndpointRun("failed")).toBe("failed");
    expect(isFinished("running")).toBe(false);
    expect(isFinished("queued")).toBe(false);
    expect(isFinished("partial")).toBe(true);
  });
});

describe("restore-check attempts", () => {
  const retry = (attempt: number, limit = MAIL_CHECK_ATTEMPTS) => ({
    retry: { attempt, limit, nextAttemptAt: null },
  });

  it("names the attempt a mail check is on from the failure it carries", () => {
    // Attempt 3 failed and waits for its retry: the row shows attempt 3 of 6 ...
    expect(mailCheckAttempt("verify", "queued", retry(3))).toEqual({ number: 3, of: 6 });
    // ... and once the retry runs it is the fourth.
    expect(mailCheckAttempt("verify", "active", retry(3))).toEqual({ number: 4, of: 6 });
    // Never beyond what the queue allows.
    expect(mailCheckAttempt("verify", "active", retry(6))).toEqual({ number: 6, of: 6 });
  });

  it("names nothing for a first attempt or for any other run", () => {
    expect(mailCheckAttempt("verify", "active", null)).toBeNull();
    expect(mailCheckAttempt("verify", "queued", { retry: null })).toBeNull();
    expect(mailCheckAttempt("backup", "queued", retry(2))).toBeNull();
  });

  it("counts a restore test on a machine by the retry number of its task", () => {
    expect(endpointCheckAttempt("verify_sample", { retry: 2 })).toEqual({
      number: 3,
      of: ENDPOINT_CHECK_ATTEMPTS,
    });
    expect(ENDPOINT_CHECK_ATTEMPTS).toBe(7);
    expect(endpointCheckAttempt("verify_sample", { retry: 6 })).toEqual({ number: 7, of: 7 });
    expect(endpointCheckAttempt("verify_sample", {})).toBeNull();
    expect(endpointCheckAttempt("verify_sample", null)).toBeNull();
    expect(endpointCheckAttempt("backup", { retry: 2 })).toBeNull();
    expect(endpointCheckAttempt("verify_sample", { retry: -1 })).toBeNull();
  });
});

describe("a mail run", () => {
  it("carries progress, speed and the newest measurements while it runs", () => {
    const samples = Array.from({ length: 100 }, (_, index) =>
      samplePoint(AT.getTime() + index * 2000, index * 10_000, index * 500),
    );
    const run = mail({}, {}, samples);
    expect(run).toMatchObject({
      id: JOB,
      source: "mail",
      kind: "backup",
      type: "backup",
      state: "running",
      subject: { kind: "mailbox", id: OBJECT, name: "Alice", detail: "alice@contoso.example" },
      cancellable: true,
      attempt: null,
    });
    expect(run.progress).toMatchObject({
      percent: 25,
      itemsDone: 50,
      itemsTotal: 200,
      bytesProcessed: 9_000,
      bytesTransferred: 400,
      bytesNew: 1_000,
      etaSeconds: 120,
    });
    expect(run.samples).toHaveLength(LIST_SAMPLE_COUNT);
    expect(run.samples?.[LIST_SAMPLE_COUNT - 1]).toEqual(samples[99]);
    // 5000 bytes processed and 250 transferred per second.
    expect(run.throughput).toEqual({ processedBps: 5000, transferredBps: 250 });
  });

  it("has no percentage while it does not know its size, and no speed when it is over", () => {
    expect(mail({}, { total: 0, done: 4 }).progress?.percent).toBeNull();
    const finished = mail({ status: "completed", completedAt: AT }, { total: 10, done: 10 }, [
      samplePoint(0, 0, 0),
      samplePoint(2000, 100, 10),
    ]);
    expect(finished.state).toBe("succeeded");
    expect(finished.throughput).toBeNull();
    expect(finished.progress?.percent).toBe(100);
    expect(finished.progress?.etaSeconds).toBeNull();
    expect(finished.cancellable).toBe(false);
    // The measurements stay: the charts of a finished run.
    expect(finished.samples).toHaveLength(2);
  });

  it("reads a row from before processed bytes were counted as having processed what it stored", () => {
    const run = mail({}, { bytes: 4096, bytesProcessed: 0, bytesTransferred: 0 });
    expect(run.progress?.bytesProcessed).toBe(4096);
  });

  it("is partial when it completed with failed items, never plain success", () => {
    const run = mail({ status: "completed", completedAt: AT }, { total: 5, done: 4, failed: 1 });
    expect(run.state).toBe("partial");
  });

  it("is a restore check on its tab and shows an attempt that was repeated", () => {
    const failure = {
      v: 1,
      code: "storage.unreachable",
      transient: true,
      params: {},
      technical: {},
      at: AT.toISOString(),
      step: null,
      retry: { attempt: 2, limit: 6, nextAttemptAt: "2026-10-02T11:00:00.000Z" },
    };
    const run = mail({ queue: "verify", status: "queued", failure: failure as never }, null);
    expect(run.kind).toBe("restore_check");
    expect(run.attempt).toEqual({ number: 2, of: 6 });
    expect(run.progress).toBeNull();
  });

  it("belongs to the backup job it was queued for, and is triggered by it", () => {
    const row = {
      job: jobRow({ payload: { backupJobId: "b1" } }),
      progress: null,
      object: mailbox,
    };
    const run = mailRun({
      row,
      dto: toJobDto(row),
      job: { id: "b1", name: "Mail backup" },
    });
    expect(run.job).toEqual({ id: "b1", name: "Mail backup" });
    expect(run.trigger).toBe("scheduled");
  });
});

const MACHINE = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  hostname: "fs-bergisch",
  displayName: null,
  profile: "server" as const,
  os: "linux",
};

function agentRun(overrides: Partial<EndpointRun> = {}): EndpointRun {
  return {
    id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    tenantId: TENANT,
    endpointId: MACHINE.id,
    kind: "backup",
    status: "running",
    startedAt: AT,
    finishedAt: null,
    snapshotId: null,
    stats: null,
    errors: [],
    logTail: null,
    failure: null,
    progress: {
      filesDone: 4000,
      bytesDone: 4_000_000,
      totalFiles: 10_000,
      totalBytes: 10_000_000,
      currentPath: "/srv/data/x.db",
      updatedAt: "2026-10-02T10:00:05.000Z",
    },
    taskId: null,
    alertedAt: null,
    createdAt: AT,
    ...overrides,
  } as EndpointRun;
}

describe("an agent run", () => {
  it("shows what the agent reports and what the server measured", () => {
    const run = endpointRun({
      run: agentRun(),
      endpoint: MACHINE,
      taskParams: null,
      job: { id: "j1", name: "Linux servers" },
      rated: false,
      samples: [
        samplePoint(AT.getTime(), 0, 0),
        samplePoint(AT.getTime() + 5000, 4_000_000, 250_000),
      ],
    });
    expect(run).toMatchObject({
      source: "endpoint",
      kind: "backup",
      type: "backup",
      state: "running",
      cancellable: false,
      trigger: "scheduled",
      subject: { kind: "server", name: "fs-bergisch", detail: "linux" },
      job: { id: "j1", name: "Linux servers" },
    });
    expect(run.progress).toMatchObject({
      percent: 40,
      itemsDone: 4000,
      itemsTotal: 10_000,
      bytesProcessed: 4_000_000,
      bytesTransferred: 250_000,
      bytesTotal: 10_000_000,
      currentPath: "/srv/data/x.db",
    });
    // 800 kB/s processed, 6 MB to go: ten seconds, about.
    expect(run.throughput?.processedBps).toBe(800_000);
    expect(run.progress?.etaSeconds).toBe(8);
  });

  it("takes its totals from the stats once it finished, and is partial when files were skipped", () => {
    const run = endpointRun({
      run: agentRun({
        status: "partial",
        finishedAt: new Date(AT.getTime() + 60_000),
        progress: null,
        snapshotId: "abc123",
        stats: {
          filesNew: 10,
          filesChanged: 5,
          dataAdded: 1234,
          totalFilesProcessed: 900,
          totalBytesProcessed: 5_000_000,
        },
        errors: [{ path: "/x", message: "permission denied" }],
      }),
      endpoint: MACHINE,
      taskParams: null,
      job: null,
      rated: true,
    });
    expect(run.state).toBe("partial");
    expect(run.progress).toMatchObject({
      percent: 100,
      bytesProcessed: 5_000_000,
      bytesNew: 1234,
      itemsDone: 15,
      itemsTotal: 900,
      itemsFailed: 1,
      etaSeconds: null,
    });
    expect(run.errorMessage).toBe("permission denied");
  });

  it("is not a failure to report when the agent was only restarted", () => {
    const run = endpointRun({
      run: agentRun({
        status: "failed",
        finishedAt: AT,
        progress: null,
        errors: [{ message: "The agent stopped", code: "interrupted" }],
      }),
      endpoint: MACHINE,
      taskParams: null,
      job: null,
      rated: false,
    });
    expect(run.state).toBe("failed");
    expect(run.errorMessage).toBeNull();
  });

  it("marks a restore test nothing rated as incomplete, and counts its retries", () => {
    const test = agentRun({
      kind: "verify_sample",
      status: "failed",
      finishedAt: AT,
      progress: null,
      taskId: "cccccccc-3333-4333-8333-cccccccccccc",
    });
    const unrated = endpointRun({
      run: test,
      endpoint: MACHINE,
      taskParams: { snapshotId: "s", retry: 2 },
      job: null,
      rated: false,
    });
    expect(unrated.kind).toBe("restore_check");
    expect(unrated.checkIncomplete).toBe(true);
    expect(unrated.attempt).toEqual({ number: 3, of: 7 });
    expect(unrated.trigger).toBe("manual");
    const rated = endpointRun({
      run: { ...test, status: "succeeded" },
      endpoint: MACHINE,
      taskParams: { snapshotId: "s", retry: 2 },
      job: null,
      rated: true,
    });
    expect(rated.checkIncomplete).toBe(false);
  });

  it("names a machine by its display name when it has one", () => {
    const run = endpointRun({
      run: agentRun(),
      endpoint: { ...MACHINE, displayName: "  Fileserver Bergisch  " },
      taskParams: null,
      job: null,
      rated: false,
    });
    expect(run.subject?.name).toBe("Fileserver Bergisch");
  });
});

describe("batch and timeline", () => {
  it("counts a wave by state", () => {
    expect(batchOf(["running", "succeeded", "succeeded", "failed", "queued"])).toEqual({
      total: 5,
      queued: 1,
      running: 1,
      succeeded: 2,
      partial: 0,
      failed: 1,
      cancelled: 0,
      truncated: false,
    });
    expect(batchOf([], { truncated: true }).truncated).toBe(true);
  });

  it("orders the lines by time, keeps the order of equal times, and measures the gaps", () => {
    const lines = timeline([
      { at: "2026-10-02T10:00:10.000Z", type: "completed", params: {} },
      { at: "2026-10-02T10:00:00.000Z", type: "queued", params: {} },
      { at: "2026-10-02T10:00:02.000Z", type: "started", params: {} },
      { at: "2026-10-02T10:00:02.000Z", type: "phase", params: {} },
    ]);
    expect(lines.map((line) => line.type)).toEqual(["queued", "started", "phase", "completed"]);
    expect(lines.map((line) => line.durationMs)).toEqual([null, 2000, 0, 8000]);
  });
});
