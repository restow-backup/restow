import { describe, expect, it } from "vitest";

import type { BackupTarget, Job, JobPage } from "@/features/jobs/api";
import {
  SNAPSHOT_STATE_VARIANT,
  STATUS_VARIANT,
  durationParts,
  isWaitingForThrottle,
  jobDurationSeconds,
  jobStatusDisplay,
  jobTriggerKey,
  jobsOfEvent,
  matchesFilters,
  matchesTargetSearch,
  objectLabel,
  phaseLabel,
  progressBytesKey,
  progressCountKey,
  progressRatio,
  replaceJobInPages,
  throttleRemainingMs,
  withLatestJob,
} from "@/features/jobs/presenters";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    queue: "backup",
    status: "active",
    protectedObjectId: "object-1",
    object: null,
    scheduleId: null,
    full: false,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    startedAt: "2026-01-01T10:00:00.000Z",
    completedAt: null,
    errorMessage: null,
    progress: null,
    phase: null,
    throttle: null,
    cancellable: true,
    retryable: false,
    ...overrides,
  };
}

const T0 = Date.parse("2026-01-01T10:00:00.000Z");

describe("progress", () => {
  it("counts failed items as processed and waits for a known total", () => {
    const base = { bytes: 0, etaSeconds: null, updatedAt: "" };
    expect(progressRatio(null)).toBeNull();
    expect(progressRatio({ ...base, total: 0, done: 5, failed: 0 })).toBeNull();
    expect(progressRatio({ ...base, total: 10, done: 4, failed: 1 })).toBe(0.5);
    expect(progressRatio({ ...base, total: 10, done: 12, failed: 0 })).toBe(1);
  });

  it("says 'no changes' for a completed run that had nothing to do, never for a check", () => {
    const empty = { total: 0, done: 0, failed: 0, bytes: 0, etaSeconds: null, updatedAt: "" };
    expect(progressCountKey(job({ status: "completed", progress: empty }))).toBe("noChanges");
    expect(progressCountKey(job({ status: "completed", progress: null }))).toBe("noChanges");
    // A restore check always reads something: an empty one is not "no changes".
    expect(progressCountKey(job({ queue: "verify", status: "completed", progress: empty }))).toBe(
      "noItems",
    );
  });

  it("never says 'so far' once a run has finished", () => {
    const empty = { total: 0, done: 0, failed: 0, bytes: 0, etaSeconds: null, updatedAt: "" };
    // Running or waiting: more may come.
    for (const status of ["queued", "active"] as const) {
      expect(progressCountKey(job({ status, progress: empty }))).toBe("itemsOpen");
      expect(progressCountKey(job({ status, progress: { ...empty, done: 3 } }))).toBe("itemsOpen");
    }
    // A failed or cancelled run that got nowhere says so plainly.
    for (const status of ["failed", "cancelled"] as const) {
      expect(progressCountKey(job({ status, progress: empty }))).toBe("noItems");
      expect(progressCountKey(job({ status, progress: null }))).toBe("noItems");
      expect(progressCountKey(job({ queue: "verify", status, progress: empty }))).toBe("noItems");
      expect(progressCountKey(job({ status, progress: { ...empty, done: 3 } }))).toBe("itemsDone");
      expect(progressCountKey(job({ status, progress: { ...empty, failed: 2 } }))).toBe(
        "itemsDone",
      );
    }
    expect(progressCountKey(job({ status: "completed", progress: { ...empty, done: 3 } }))).toBe(
      "itemsDone",
    );
  });

  it("shows 'N of M items' whenever the total is known, finished or not", () => {
    const counted = { total: 3, done: 1, failed: 0, bytes: 0, etaSeconds: null, updatedAt: "" };
    for (const status of ["queued", "active", "completed", "failed", "cancelled"] as const) {
      expect(progressCountKey(job({ status, progress: counted }))).toBe("items");
    }
  });

  it("calls the bytes of a restore check 'read', of a backup 'new data', of a stopped one 'stored before it stopped'", () => {
    expect(progressBytesKey(job({ queue: "verify" }))).toBe("bytesRead");
    expect(progressBytesKey(job({ queue: "verify", status: "failed" }))).toBe("bytesRead");
    expect(progressBytesKey(job({ queue: "backup", status: "active" }))).toBe("bytes");
    expect(progressBytesKey(job({ queue: "backup", status: "completed" }))).toBe("bytes");
    expect(progressBytesKey(job({ queue: "backup", status: "failed" }))).toBe("bytesPartial");
    expect(progressBytesKey(job({ queue: "backup", status: "cancelled" }))).toBe("bytesPartial");
  });

  it("names what started a job, also for servers that do not send a trigger yet", () => {
    expect(jobTriggerKey(job({ trigger: "after_backup" }))).toBe("jobs.afterBackup");
    expect(jobTriggerKey(job({ trigger: "scheduled" }))).toBe("jobs.scheduled");
    expect(jobTriggerKey(job({ trigger: "manual", scheduleId: null }))).toBe("jobs.manual");
    expect(jobTriggerKey(job({ scheduleId: "s-1" }))).toBe("jobs.scheduled");
    expect(jobTriggerKey(job({ scheduleId: null }))).toBe("jobs.manual");
  });

  it("translates known phases and names unknown ones", () => {
    expect(phaseLabel("download")).toEqual({ key: "phase.download", values: {} });
    expect(phaseLabel("defragment")).toEqual({
      key: "phase.unknown",
      values: { name: "defragment" },
    });
  });
});

describe("durations", () => {
  it("picks the two largest units", () => {
    expect(durationParts(42)).toEqual({
      key: "duration.seconds",
      values: { hours: 0, minutes: 0, seconds: 42 },
    });
    expect(durationParts(125).key).toBe("duration.minutes");
    expect(durationParts(3 * 3600 + 5 * 60 + 9)).toEqual({
      key: "duration.hours",
      values: { hours: 3, minutes: 5, seconds: 9 },
    });
    expect(durationParts(Number.NaN).values.seconds).toBe(0);
    expect(durationParts(-4).values.seconds).toBe(0);
  });

  it("measures a running job against now and a finished one against its end", () => {
    expect(jobDurationSeconds(job(), T0 + 90_000)).toBe(90);
    expect(jobDurationSeconds(job({ completedAt: "2026-01-01T10:01:00.000Z" }), T0 + 999_000)).toBe(
      60,
    );
    expect(jobDurationSeconds(job({ startedAt: null }), T0)).toBeNull();
  });
});

describe("throttling", () => {
  const throttle = {
    status: 429,
    waitMs: 30_000,
    retryAfterMs: 30_000,
    until: "2026-01-01T10:00:30.000Z",
    waits: 1,
    totalWaitMs: 30_000,
  };

  it("counts down the current wait and treats a past one as over", () => {
    expect(throttleRemainingMs(throttle, T0 + 10_000)).toBe(20_000);
    expect(throttleRemainingMs(throttle, T0 + 40_000)).toBe(0);
    expect(throttleRemainingMs(null, T0)).toBe(0);
  });

  it("only a running job waits", () => {
    expect(isWaitingForThrottle(job({ throttle }), T0 + 1000)).toBe(true);
    expect(isWaitingForThrottle(job({ throttle, status: "failed" }), T0 + 1000)).toBe(false);
    expect(isWaitingForThrottle(job({ throttle }), T0 + 60_000)).toBe(false);
  });
});

describe("lists", () => {
  it("labels objects by display name, else by address", () => {
    expect(objectLabel({ displayName: "Alice", externalId: "alice@example.org" })).toBe("Alice");
    expect(objectLabel({ displayName: "  ", externalId: "alice@example.org" })).toBe(
      "alice@example.org",
    );
  });

  it("matches filters on queue and status", () => {
    expect(matchesFilters(job(), { queue: null, status: null })).toBe(true);
    expect(matchesFilters(job(), { queue: "backup", status: "active" })).toBe(true);
    expect(matchesFilters(job(), { queue: "restore", status: null })).toBe(false);
    expect(matchesFilters(job(), { queue: null, status: "failed" })).toBe(false);
  });

  it("replaces a loaded job in place and reports an unknown one", () => {
    const pages: JobPage[] = [
      { items: [job({ id: "a" }), job({ id: "b" })], next: "cursor" },
      { items: [job({ id: "c" })], next: null },
    ];
    const updated = replaceJobInPages(pages, job({ id: "c", status: "completed" }));
    expect(updated?.[1]?.items[0]?.status).toBe("completed");
    expect(updated?.[0]?.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(replaceJobInPages(pages, job({ id: "z" }))).toBeNull();
  });

  it("reads jobs out of stream events and ignores anything else", () => {
    expect(
      jobsOfEvent({ event: "jobs", data: JSON.stringify({ items: [job()] }), id: null }),
    ).toEqual([job()]);
    expect(jobsOfEvent({ event: "job", data: JSON.stringify(job()), id: "x" })).toEqual([job()]);
    expect(jobsOfEvent({ event: "job", data: "{broken", id: null })).toEqual([]);
    expect(jobsOfEvent({ event: "end", data: "{}", id: null })).toEqual([]);
  });
});

describe("backup targets", () => {
  function target(overrides: Partial<BackupTarget> = {}): BackupTarget {
    return {
      id: "object-1",
      kind: "mailbox",
      displayName: "Alice Example",
      externalId: "alice@example.org",
      status: "active",
      source: { id: "s", name: "Contoso", kind: "m365", status: "active" },
      blocked: null,
      lastSnapshot: null,
      lastJob: null,
      latestVerify: null,
      ...overrides,
    };
  }

  it("searches name, address and source case-insensitively", () => {
    expect(matchesTargetSearch(target(), "")).toBe(true);
    expect(matchesTargetSearch(target(), "ALICE")).toBe(true);
    expect(matchesTargetSearch(target(), "contoso")).toBe(true);
    expect(matchesTargetSearch(target(), "bob")).toBe(false);
  });

  it("shows the newest job of an object and ignores older or foreign ones", () => {
    const current = job({ id: "new", createdAt: "2026-01-02T00:00:00.000Z" });
    const targets = [target({ lastJob: current }), target({ id: "object-2" })];
    expect(withLatestJob(targets, job({ id: "old" }))).toBeNull();
    expect(withLatestJob(targets, job({ protectedObjectId: "object-9" }))).toBeNull();
    const progressed = { ...current, status: "completed" as const };
    expect(withLatestJob(targets, progressed)?.[0]?.lastJob).toBe(progressed);
    const newer = job({ id: "newer", createdAt: "2026-01-03T00:00:00.000Z" });
    expect(withLatestJob(targets, newer)?.[0]?.lastJob?.id).toBe("newer");
  });
});

describe("jobStatusDisplay", () => {
  it("shows a restore check that could not complete neutrally, never failed or completed", () => {
    const incomplete = { key: "jobStatus.checkIncomplete", values: {}, variant: "info" };
    // Waiting for its retry, and after its last attempt completed without a rating.
    expect(jobStatusDisplay("queued", 0, "verify", true)).toEqual(incomplete);
    expect(jobStatusDisplay("completed", 0, "verify", true)).toEqual(incomplete);
    // The retry runs: it is a running job again.
    expect(jobStatusDisplay("active", 0, "verify", true).key).toBe("jobStatus.active");
    expect(jobStatusDisplay("completed", 0, "verify", false).key).toBe("jobStatus.completed");
  });

  it("shows a clean completed run as neutral, never green: nothing has read it back", () => {
    expect(jobStatusDisplay("completed")).toEqual({
      key: "jobStatus.completed",
      values: {},
      variant: "outline",
    });
    for (const queue of [
      "backup",
      "archive",
      "directory",
      "verify",
      "retention",
      "scrub",
    ] as const) {
      expect(jobStatusDisplay("completed", 0, queue).variant, queue).toBe("outline");
    }
  });

  it("shows a restore that completed as a success: the data is back", () => {
    expect(jobStatusDisplay("completed", 0, "restore")).toEqual({
      key: "jobStatus.completed",
      values: {},
      variant: "success",
    });
    // Failed items still win.
    expect(jobStatusDisplay("completed", 2, "restore").variant).toBe("warning");
  });

  it("keeps the other states of a restore as they are", () => {
    expect(jobStatusDisplay("failed", 0, "restore").variant).toBe("destructive");
    expect(jobStatusDisplay("queued", 0, "restore").variant).toBe("muted");
  });

  it("draws a completed backup snapshot and its progress bar without green", () => {
    expect(SNAPSHOT_STATE_VARIANT.completed).toBe("outline");
    expect(STATUS_VARIANT.completed).toBe("outline");
  });

  it("never shows a completed run with failed items as a plain success", () => {
    expect(jobStatusDisplay("completed", 312)).toEqual({
      key: "jobStatus.completedWithFailures",
      values: { count: 312 },
      variant: "warning",
    });
  });

  it("keeps the other states as they are, whatever their progress says", () => {
    expect(jobStatusDisplay("failed", 4)).toEqual({
      key: "jobStatus.failed",
      values: {},
      variant: "destructive",
    });
    expect(jobStatusDisplay("active", 2).key).toBe("jobStatus.active");
    expect(jobStatusDisplay("cancelled", 1).variant).toBe("secondary");
  });
});
