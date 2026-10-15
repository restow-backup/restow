import { describe, expect, it } from "vitest";

import type { BackupJobLive, Run } from "../api";
import { agentRun, run } from "../fixtures";
import {
  activityFromGuests,
  activityFromJobs,
  activityFromLive,
  isBusy,
  runLink,
} from "./activity";
import { activityFromPve, pveRefreshMs } from "./activity-badges";

/**
 * What the sidebar counts on "Jobs" and on "VMs & containers": the backups that run, those that
 * wait, and what a click opens, from the channel or from the job list while it is down.
 */

const label = (value: Run) => `${value.job?.name} · ${value.subject?.name}`;

function definition(overrides: Partial<BackupJobLive> = {}): BackupJobLive {
  return {
    id: "job-1",
    kind: "endpoint",
    enabled: true,
    state: "ok",
    scope: { count: 3, byKind: {}, overrides: 0 },
    lastRun: { at: null, failed: 0, partial: 0, running: 0, queued: 0, runId: null },
    nextRunAt: null,
    restoreCheck: {
      passed: 0,
      warning: 0,
      failed: 0,
      unverified: 0,
      noBackup: 0,
      total: 0,
      checkedAt: null,
    },
    updatedAt: "2026-10-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("activityFromLive", () => {
  it("counts the running backups of the area, the one started first first, and opens each in the job list", () => {
    const runs = {
      b: run({ id: "b", startedAt: "2026-10-02T10:05:00.000Z" }),
      a: run({ id: "a", startedAt: "2026-10-02T10:01:00.000Z" }),
      q: run({ id: "q", state: "queued", startedAt: null }),
      done: run({ id: "done", state: "succeeded" }),
      check: run({ id: "check", kind: "restore_check" }),
      agent: agentRun({ id: "agent" }),
    };
    const activity = activityFromLive(runs, {}, "mail", label);
    expect(activity.running).toBe(2);
    expect(activity.queued).toBe(1);
    expect(activity.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(activity.items[0]).toEqual({
      id: "a",
      label: "Mail backup · anna@contoso.example",
      percent: 40,
      to: "/jobs",
      search: { type: "mail", run: "a" },
    });
  });

  it("counts machines whose requested backup waits for them, from the jobs the channel describes", () => {
    const activity = activityFromLive(
      { agent: agentRun({ id: "agent" }) },
      {
        "job-1": definition({ lastRun: { ...definition().lastRun, queued: 2 } }),
        "job-2": definition({
          id: "job-2",
          kind: "mail",
          lastRun: { ...definition().lastRun, queued: 5 },
        }),
      },
      "endpoint",
      label,
    );
    expect(activity.running).toBe(1);
    expect(activity.queued).toBe(2);
    expect(activity.items[0]?.search).toEqual({ type: "endpoint", run: "agent" });
  });

  it("is idle without anything that runs or waits", () => {
    expect(isBusy(activityFromLive({}, {}, "mail", label))).toBe(false);
    expect(isBusy(null)).toBe(false);
  });
});

describe("activityFromJobs", () => {
  it("adds up what the jobs of the area say and opens each job's current run", () => {
    const jobs = [
      {
        id: "1",
        kind: "mail" as const,
        name: "Mailboxes",
        lastRun: { ...definition().lastRun, running: 2, runId: "r1" },
      },
      {
        id: "2",
        kind: "mail" as const,
        name: "Shared",
        lastRun: { ...definition().lastRun, queued: 1 },
      },
      {
        id: "3",
        kind: "endpoint" as const,
        name: "Servers",
        lastRun: { ...definition().lastRun, running: 4, runId: "r3" },
      },
    ];
    const activity = activityFromJobs(jobs, "mail");
    expect(activity).toEqual({
      running: 2,
      queued: 1,
      items: [{ id: "1", label: "Mailboxes", percent: null, ...runLink("mail", "r1") }],
    });
  });
});

describe("activityFromGuests", () => {
  it("counts the guests that back up and those that wait for their node, and opens a guest's page", () => {
    const activity = activityFromGuests(
      [
        { id: "g1", vmid: 101, name: "dc01", jobName: "Nightly", activity: "running" },
        { id: "g2", vmid: 102, name: null, jobName: null, activity: "running" },
        { id: "g3", vmid: 103, name: "web", jobName: "Nightly", activity: "queued" },
        { id: "g4", vmid: 104, name: "idle", jobName: null, activity: null },
        { id: "g5", vmid: 105, name: "old", jobName: null },
      ],
      (id) => `/virtualization/${id}`,
    );
    expect(activity.running).toBe(2);
    expect(activity.queued).toBe(1);
    expect(activity.items).toEqual([
      { id: "g1", label: "Nightly · dc01", percent: null, to: "/virtualization/g1" },
      { id: "g2", label: "102", percent: null, to: "/virtualization/g2" },
    ]);
  });
});

describe("pveRefreshMs", () => {
  const guest = { id: "g1", vmid: 101, name: "dc01", jobName: null };
  const summary = (running: number, queued = 0, connected = true) => ({
    connected,
    running: Array.from({ length: running }, () => guest),
    queued,
  });

  it("asks quickly while a guest backs up or waits, now and then otherwise, and never without Proxmox VE", () => {
    expect(pveRefreshMs("success", summary(1))).toBe(5_000);
    expect(pveRefreshMs("success", summary(0, 2))).toBe(5_000);
    expect(pveRefreshMs("success", summary(0))).toBe(60_000);
    expect(pveRefreshMs("success", summary(0, 0, false))).toBe(false);
    expect(pveRefreshMs("error", undefined)).toBe(false);
    expect(pveRefreshMs("pending", undefined)).toBe(60_000);
  });
});

describe("activityFromPve", () => {
  it("lists the running guests by name and counts those that wait", () => {
    const activity = activityFromPve({
      connected: true,
      running: [{ id: "g1", vmid: 101, name: "dc01", jobName: "Nightly" }],
      queued: 3,
    });
    expect(activity).toEqual({
      running: 1,
      queued: 3,
      items: [{ id: "g1", label: "Nightly · dc01", percent: null, to: "/virtualization/g1" }],
    });
    expect(activityFromPve(undefined)).toEqual({ running: 0, queued: 0, items: [] });
  });
});
