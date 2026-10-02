import type { Job, JobProgress, Snapshot } from "@restow/db";
import { describe, expect, it } from "vitest";
import {
  type JobObjectDto,
  backupBlockedReason,
  backupResultOf,
  isRetryable,
  runtimePhaseOf,
  runtimeThrottleOf,
  snapshotStateOf,
  toJobDto,
  toSnapshotDto,
  toSnapshotHistoryEntry,
  verifySummaryOf,
} from "./dto.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const JOB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OBJECT = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const AT = new Date("2026-01-01T10:00:00.000Z");

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
    startedAt: AT,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const progress: JobProgress = {
  id: "1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a",
  tenantId: TENANT,
  jobId: JOB,
  total: 100,
  done: 40,
  failed: 2,
  bytes: 4096,
  bytesProcessed: 4096,
  bytesTransferred: 0,
  etaSeconds: 120,
  createdAt: AT,
  updatedAt: AT,
};

const runtime = {
  phase: "download",
  phaseSince: "2026-01-01T10:00:05.000Z",
  throttle: {
    status: 429,
    waitMs: 32_000,
    retryAfterMs: 32_000,
    until: "2026-01-01T10:00:37.000Z",
    waits: 3,
    totalWaitMs: 50_000,
  },
};

describe("runtime state", () => {
  it("reads the phase and the throttling wait the worker stored", () => {
    const payload = { runtime };
    expect(runtimePhaseOf(payload)).toEqual({
      name: "download",
      since: "2026-01-01T10:00:05.000Z",
    });
    expect(runtimeThrottleOf(payload)).toEqual(runtime.throttle);
  });

  it("ignores missing or malformed documents instead of failing", () => {
    expect(runtimePhaseOf(null)).toBeNull();
    expect(runtimePhaseOf({ runtime: "enumerate" })).toBeNull();
    expect(runtimePhaseOf({ runtime: { phase: "" } })).toBeNull();
    expect(runtimePhaseOf({ runtime: { phase: "x", phaseSince: 5 } })).toEqual({
      name: "x",
      since: null,
    });
    expect(runtimeThrottleOf({ runtime: { throttle: { status: "429" } } })).toBeNull();
    expect(
      runtimeThrottleOf({ runtime: { throttle: { status: 429, waitMs: 5, until: "soon" } } }),
    ).toBeNull();
    expect(
      runtimeThrottleOf({
        runtime: { throttle: { status: 503, waitMs: 500, until: "2026-01-01T10:00:00Z" } },
      }),
    ).toEqual({
      status: 503,
      waitMs: 500,
      retryAfterMs: null,
      until: "2026-01-01T10:00:00Z",
      waits: 1,
      totalWaitMs: 500,
    });
  });
});

describe("toJobDto", () => {
  it("maps a running backup with progress, phase and throttling", () => {
    const dto = toJobDto({
      job: jobRow({ payload: { full: true, scheduleId: "s-1", runtime } }),
      progress,
      object: mailbox,
    });
    expect(dto).toMatchObject({
      id: JOB,
      queue: "backup",
      status: "active",
      object: mailbox,
      scheduleId: "s-1",
      trigger: "scheduled",
      full: true,
      startedAt: "2026-01-01T10:00:00.000Z",
      progress: { total: 100, done: 40, failed: 2, bytes: 4096, etaSeconds: 120 },
      phase: { name: "download" },
      throttle: { waits: 3 },
      cancellable: true,
      retryable: false,
    });
  });

  it('counts what the scheduler planned for a backup job as scheduled, and "Run now" as manual', () => {
    const trigger = (payload: Record<string, unknown>) =>
      toJobDto({ job: jobRow({ payload }), progress: null, object: mailbox });
    expect(trigger({ backupJobId: "job-1" })).toMatchObject({
      trigger: "scheduled",
      backupJobId: "job-1",
      scheduleId: null,
    });
    expect(trigger({ backupJobId: "job-1", runNow: true })).toMatchObject({
      trigger: "manual",
      backupJobId: "job-1",
    });
    // The restore check that follows a backup says so, whichever job asked for it.
    expect(trigger({ backupJobId: "job-1", afterBackup: true }).trigger).toBe("after_backup");
  });

  it("tells a manual job from a restore check queued right after a backup", () => {
    expect(
      toJobDto({ job: jobRow({ payload: {} }), progress: null, object: mailbox }).trigger,
    ).toBe("manual");
    expect(
      toJobDto({
        job: jobRow({ queue: "verify", payload: { afterBackup: true } }),
        progress: null,
        object: mailbox,
      }).trigger,
    ).toBe("after_backup");
  });

  it("hides phase and throttling once a job is no longer running", () => {
    for (const status of ["queued", "completed", "failed", "cancelled"] as const) {
      const dto = toJobDto({
        job: jobRow({ status, payload: { runtime } }),
        progress: null,
        object: mailbox,
      });
      expect(dto.phase).toBeNull();
      expect(dto.throttle).toBeNull();
      expect(dto.progress).toBeNull();
    }
  });

  it("flags a restore check whose attempt could not complete, never another job or a running one", () => {
    const incomplete = { result: { incomplete: true, willRetry: true, reason: "storage down" } };
    const dto = (status: "queued" | "completed" | "active", queue = "verify" as const) =>
      toJobDto({
        job: jobRow({ status, queue, payload: incomplete }),
        progress: null,
        object: mailbox,
      });
    // Waiting for its retry, and after the last attempt completed without a rating.
    expect(dto("queued").checkIncomplete).toBe(true);
    expect(dto("completed").checkIncomplete).toBe(true);
    // The retry runs: it is the running check now.
    expect(dto("active").checkIncomplete).toBe(false);
    // A rated check and any other job are not.
    expect(
      toJobDto({
        job: jobRow({
          status: "completed",
          queue: "verify",
          payload: { result: { readiness: "red" } },
        }),
        progress: null,
        object: mailbox,
      }).checkIncomplete,
    ).toBe(false);
    expect(
      toJobDto({
        job: jobRow({ status: "completed", queue: "backup", payload: incomplete }),
        progress: null,
        object: mailbox,
      }).checkIncomplete,
    ).toBe(false);
  });

  it("offers cancel for queued and running jobs and retry for finished failures", () => {
    const queued = toJobDto({ job: jobRow({ status: "queued" }), progress: null, object: mailbox });
    expect(queued.cancellable).toBe(true);
    const failed = toJobDto({ job: jobRow({ status: "failed" }), progress: null, object: mailbox });
    expect(failed).toMatchObject({ cancellable: false, retryable: true });
  });
});

describe("isRetryable", () => {
  it("allows failed or cancelled backups and verifies of an active object", () => {
    expect(isRetryable({ queue: "backup", status: "failed" }, mailbox)).toBe(true);
    expect(isRetryable({ queue: "verify", status: "cancelled" }, mailbox)).toBe(true);
  });

  it("refuses other queues, other states and objects that are gone or excluded", () => {
    expect(isRetryable({ queue: "restore", status: "failed" }, mailbox)).toBe(false);
    expect(isRetryable({ queue: "backup", status: "completed" }, mailbox)).toBe(false);
    expect(isRetryable({ queue: "backup", status: "failed" }, null)).toBe(false);
    expect(
      isRetryable({ queue: "backup", status: "failed" }, { ...mailbox, status: "excluded" }),
    ).toBe(false);
  });
});

describe("backupResultOf", () => {
  const result = {
    snapshotId: "snap-1",
    sequence: 3,
    objectsWritten: 5,
    objectsTotal: 800,
    bytes: 1024,
    failures: 1,
    repairedCopies: 0,
    verifyJobId: null,
    throttleWaits: 2,
    throttleWaitMs: 9000,
    completedAt: "2026-01-01T11:00:00.000Z",
  };

  it("reads a backup's stored result", () => {
    expect(backupResultOf("backup", { result })).toEqual(result);
  });

  it("ignores other queues and incomplete documents", () => {
    expect(backupResultOf("restore", { result })).toBeNull();
    expect(backupResultOf("backup", { result: { snapshotId: "snap-1" } })).toBeNull();
    expect(backupResultOf("backup", null)).toBeNull();
    expect(
      backupResultOf("backup", { result: { snapshotId: "s", completedAt: "t", bytes: "a lot" } }),
    ).toMatchObject({ bytes: 0, sequence: 0, verifyJobId: null });
  });
});

describe("snapshots", () => {
  function snapshotRow(overrides: Partial<Snapshot> = {}): Snapshot {
    return {
      id: "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d",
      tenantId: TENANT,
      protectedObjectId: OBJECT,
      jobId: JOB,
      sequence: 2,
      manifestPath: `tenants/${TENANT}/manifests/x.json.zst`,
      status: "active",
      itemCount: 10,
      byteSize: 2048,
      startedAt: AT,
      completedAt: AT,
      createdAt: AT,
      updatedAt: AT,
      ...overrides,
    };
  }

  it("derives running, completed, incomplete and pruned honestly", () => {
    expect(snapshotStateOf(snapshotRow(), "completed")).toBe("completed");
    expect(snapshotStateOf(snapshotRow({ manifestPath: null }), "active")).toBe("running");
    expect(snapshotStateOf(snapshotRow({ manifestPath: null }), "queued")).toBe("running");
    expect(snapshotStateOf(snapshotRow({ manifestPath: null }), "failed")).toBe("incomplete");
    expect(snapshotStateOf(snapshotRow({ manifestPath: null }), null)).toBe("incomplete");
    expect(snapshotStateOf(snapshotRow({ status: "pruned" }), "completed")).toBe("pruned");
  });

  it("maps a row with its state", () => {
    expect(toSnapshotDto(snapshotRow(), null)).toEqual({
      id: "4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d",
      sequence: 2,
      state: "completed",
      itemCount: 10,
      byteSize: 2048,
      startedAt: "2026-01-01T10:00:00.000Z",
      completedAt: "2026-01-01T10:00:00.000Z",
      jobId: JOB,
    });
  });

  it("gives a restorable history entry its own verification, unverified by default", () => {
    const green = { state: "green" as const, checkedAt: AT.toISOString(), reportId: "r1" };
    expect(toSnapshotHistoryEntry(snapshotRow(), null, green)).toMatchObject({
      state: "completed",
      verification: green,
    });
    expect(toSnapshotHistoryEntry(snapshotRow(), null, undefined).verification).toEqual({
      state: "unverified",
      checkedAt: null,
      reportId: null,
    });
  });

  it("has no verification for snapshots that cannot be restored", () => {
    const green = { state: "green" as const, checkedAt: AT.toISOString(), reportId: "r1" };
    for (const [row, status] of [
      [snapshotRow({ manifestPath: null }), "active"],
      [snapshotRow({ manifestPath: null }), "failed"],
      [snapshotRow({ status: "pruned" }), "completed"],
    ] as const) {
      expect(toSnapshotHistoryEntry(row, status, green).verification).toBeNull();
    }
  });
});

describe("verifySummaryOf", () => {
  it("summarizes the report that rates the newest backup", () => {
    expect(
      verifySummaryOf({
        report: {
          id: "r1",
          objectId: OBJECT,
          snapshotId: "s2",
          kind: "health_check",
          readiness: "yellow",
          checkedAt: AT,
          jobId: null,
          origin: "verify",
          reasons: [],
          counts: null,
        },
      }),
    ).toEqual({ kind: "health_check", recoveryReadiness: "yellow", checkedAt: AT.toISOString() });
  });

  it("has nothing while the newest backup is unverified", () => {
    expect(verifySummaryOf({ report: null })).toBeNull();
    expect(verifySummaryOf(undefined)).toBeNull();
  });
});

describe("backupBlockedReason", () => {
  it("names what an operator has to fix first", () => {
    expect(backupBlockedReason("excluded", "active")).toBe("excluded");
    expect(backupBlockedReason("orphaned", "active")).toBe("orphaned");
    expect(backupBlockedReason("active", "pending")).toBe("source_pending");
    expect(backupBlockedReason("active", "disabled")).toBe("source_disabled");
  });

  it("lets active objects of working or failing sources run", () => {
    expect(backupBlockedReason("active", "active")).toBeNull();
    expect(backupBlockedReason("active", "error")).toBeNull();
  });
});
