import { describe, expect, it } from "vitest";
import {
  type ScheduleRow,
  type TenantTargets,
  computeNextRunAt,
  expandSchedule,
  isDue,
  scrubModeFor,
} from "./planning.js";
import { singletonKeyFor } from "./queues.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";
const now = new Date("2026-03-01T10:00:00Z");

function schedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: "sched-1",
    tenantId: TENANT,
    protectedObjectId: null,
    kind: "backup",
    intervalMinutes: 60,
    cron: null,
    timezone: "UTC",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    ...overrides,
  };
}

const targets: TenantTargets = {
  sources: [
    { id: "src-m365", kind: "m365", status: "active" },
    { id: "src-imap", kind: "imap", status: "error" },
    { id: "src-pending", kind: "m365", status: "pending" },
    { id: "src-off", kind: "imap", status: "disabled" },
  ],
  protectedObjects: [
    { id: "mb-1", sourceId: "src-m365", kind: "mailbox", status: "active" },
    { id: "od-1", sourceId: "src-m365", kind: "onedrive", status: "active" },
    { id: "mb-excluded", sourceId: "src-m365", kind: "mailbox", status: "excluded" },
    { id: "mb-orphan", sourceId: "src-m365", kind: "mailbox", status: "orphaned" },
    { id: "imap-1", sourceId: "src-imap", kind: "imap", status: "active" },
    { id: "mb-pending", sourceId: "src-pending", kind: "mailbox", status: "active" },
    { id: "imap-off", sourceId: "src-off", kind: "imap", status: "active" },
  ],
};

let counter = 0;
const newJobId = () => `job-${++counter}`;

describe("isDue", () => {
  it("is due when never run, or when the next run has arrived", () => {
    expect(isDue(schedule(), now)).toBe(true);
    expect(isDue(schedule({ nextRunAt: new Date("2026-03-01T10:00:00Z") }), now)).toBe(true);
    expect(isDue(schedule({ nextRunAt: new Date("2026-03-01T09:59:00Z") }), now)).toBe(true);
  });

  it("is not due before the next run or when disabled", () => {
    expect(isDue(schedule({ nextRunAt: new Date("2026-03-01T10:00:01Z") }), now)).toBe(false);
    expect(isDue(schedule({ enabled: false }), now)).toBe(false);
  });
});

describe("computeNextRunAt", () => {
  it("adds the interval to the tick time", () => {
    expect(computeNextRunAt(schedule({ intervalMinutes: 90 }), now).toISOString()).toBe(
      "2026-03-01T11:30:00.000Z",
    );
  });

  it("follows cron expressions in the schedule's zone", () => {
    const nightly = schedule({
      intervalMinutes: null,
      cron: "30 2 * * *",
      timezone: "Europe/Berlin",
    });
    expect(computeNextRunAt(nightly, now).toISOString()).toBe("2026-03-02T01:30:00.000Z");
  });

  it("rejects unusable schedules instead of guessing", () => {
    expect(() => computeNextRunAt(schedule({ intervalMinutes: null, cron: null }), now)).toThrow(
      /neither/,
    );
    expect(() => computeNextRunAt(schedule({ intervalMinutes: null, cron: "x" }), now)).toThrow();
    expect(() =>
      computeNextRunAt(
        schedule({ intervalMinutes: null, cron: "0 0 * * *", timezone: "Nowhere/City" }),
        now,
      ),
    ).toThrow(/time zone/);
    expect(() =>
      computeNextRunAt(schedule({ intervalMinutes: null, cron: "0 0 31 2 *" }), now),
    ).toThrow(/never matches/);
  });
});

describe("expandSchedule", () => {
  it("backs up every active object of a usable source", () => {
    const jobs = expandSchedule(schedule({ kind: "backup" }), targets, newJobId);
    expect(jobs.map((j) => j.protectedObjectId)).toEqual(["mb-1", "od-1", "imap-1"]);
    for (const job of jobs) {
      expect(job.queue).toBe("backup");
      expect(job.priority).toBe(40);
      expect(job.payload).toMatchObject({
        tenantId: TENANT,
        scheduleId: "sched-1",
        protectedObjectId: job.protectedObjectId,
      });
      expect(job.singletonKey).toBe(`backup:${job.protectedObjectId}`);
      expect(job.payload.jobId).toMatch(/^job-\d+$/);
    }
  });

  it("narrows to one object and skips objects that are not protectable", () => {
    expect(expandSchedule(schedule({ protectedObjectId: "od-1" }), targets, newJobId)).toHaveLength(
      1,
    );
    expect(
      expandSchedule(schedule({ protectedObjectId: "mb-excluded" }), targets, newJobId),
    ).toEqual([]);
    expect(
      expandSchedule(schedule({ protectedObjectId: "mb-pending" }), targets, newJobId),
    ).toEqual([]);
    expect(expandSchedule(schedule({ protectedObjectId: "imap-off" }), targets, newJobId)).toEqual(
      [],
    );
    expect(expandSchedule(schedule({ protectedObjectId: "missing" }), targets, newJobId)).toEqual(
      [],
    );
  });

  it("verifies with the sampled verify kind", () => {
    const jobs = expandSchedule(schedule({ kind: "verify" }), targets, newJobId);
    expect(jobs).toHaveLength(3);
    expect(jobs[0].payload).toMatchObject({ kind: "verify", protectedObjectId: "mb-1" });
    expect(jobs[0].priority).toBe(80);
  });

  it("plans one tenant-wide retention and scrub job", () => {
    const [retention] = expandSchedule(schedule({ kind: "retention" }), targets, newJobId);
    expect(retention).toMatchObject({
      queue: "retention",
      protectedObjectId: null,
      singletonKey: `retention:${TENANT}`,
    });

    const [weekly] = expandSchedule(
      schedule({ kind: "scrub", intervalMinutes: 7 * 24 * 60 }),
      targets,
      newJobId,
    );
    expect(weekly.payload).toMatchObject({ mode: "sample" });
    const [monthly] = expandSchedule(
      schedule({ kind: "scrub", intervalMinutes: null, cron: "0 3 1 * *" }),
      targets,
      newJobId,
    );
    expect(monthly.payload).toMatchObject({ mode: "full" });
    expect(scrubModeFor(schedule({ intervalMinutes: 40 * 24 * 60 }))).toBe("full");
    expect(scrubModeFor(schedule({ intervalMinutes: null, cron: "0 3 * * 0" }))).toBe("sample");
  });

  it("syncs the directory once per usable m365 source", () => {
    const jobs = expandSchedule(schedule({ kind: "directory" }), targets, newJobId);
    expect(jobs.map((j) => j.payload)).toEqual([expect.objectContaining({ sourceId: "src-m365" })]);
    expect(jobs[0].singletonKey).toBe("directory:src-m365");
  });

  it("archives per source, or per mailbox when narrowed, with the matching capture", () => {
    const perSource = expandSchedule(schedule({ kind: "archive" }), targets, newJobId);
    expect(perSource.map((j) => j.payload)).toEqual([
      expect.objectContaining({ sourceId: "src-m365", capture: "graph_sync" }),
      expect.objectContaining({ sourceId: "src-imap", capture: "imap_sync" }),
    ]);
    expect(perSource[1].singletonKey).toBe(`archive:${TENANT}:src-imap`);

    const [mailbox] = expandSchedule(
      schedule({ kind: "archive", protectedObjectId: "imap-1" }),
      targets,
      newJobId,
    );
    expect(mailbox.payload).toMatchObject({ protectedObjectId: "imap-1", capture: "imap_sync" });
    // OneDrives have nothing to archive.
    expect(
      expandSchedule(schedule({ kind: "archive", protectedObjectId: "od-1" }), targets, newJobId),
    ).toEqual([]);
  });

  it("uses the same singleton keys as the worker contract", () => {
    expect(singletonKeyFor("scrub", { jobId: "j", tenantId: TENANT, mode: "full" })).toBe(
      `scrub:${TENANT}`,
    );
    expect(
      singletonKeyFor("archive", { jobId: "j", tenantId: TENANT, capture: "graph_sync" }),
    ).toBe(`archive:${TENANT}:tenant`);
  });
});

describe("the import source (imported mailboxes)", () => {
  const withImport: TenantTargets = {
    sources: [...targets.sources, { id: "src-import", kind: "import", status: "active" }],
    protectedObjects: [
      ...targets.protectedObjects,
      { id: "imported-1", sourceId: "src-import", kind: "imap", status: "active" },
    ],
  };
  const kinds = ["backup", "verify", "archive", "directory"] as const;

  it("adds no job of any kind: nothing is backed up, verified or archived from imported files", () => {
    for (const kind of kinds) {
      const plain = expandSchedule(schedule({ kind }), targets, newJobId);
      const extended = expandSchedule(schedule({ kind }), withImport, newJobId);
      expect(extended.map((job) => job.singletonKey)).toEqual(plain.map((job) => job.singletonKey));
    }
    const backups = expandSchedule(schedule({ kind: "backup" }), withImport, newJobId);
    expect(backups.map((job) => job.protectedObjectId)).not.toContain("imported-1");
  });

  it("plans nothing for a schedule narrowed to an imported mailbox", () => {
    for (const kind of ["backup", "verify", "archive"] as const) {
      expect(
        expandSchedule(schedule({ kind, protectedObjectId: "imported-1" }), withImport, newJobId),
      ).toEqual([]);
    }
  });
});
