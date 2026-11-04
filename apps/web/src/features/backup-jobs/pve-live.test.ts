import { describe, expect, it } from "vitest";

import type { PveRunning } from "@/features/history/api";
import { run as liveRun } from "@/features/history/fixtures";
import type { PveGuest, PveJob } from "@/features/pve/api";

import { jobActivity } from "./components/job-run-controls.js";
import { mailJob } from "./fixtures.js";
import { isRunOfPveJob, pveRoundPercent, runShare, runsOfPveJob } from "./pve-live.js";

/**
 * What of a Proxmox VE job runs now, from the live channel: which runs are the job's (by the job
 * id the server names from 0.5.0, by its name before), and how far its round is with them.
 */

const JOB = { id: "pj-1", name: "VMs & containers monthly" };

function pveRun(over: Partial<PveRunning> = {}): PveRunning {
  return {
    id: "run-1",
    kind: "backup",
    guest: { id: "g-1", vmid: 101, name: "web01", kind: "vm" },
    jobId: "pj-1",
    jobName: "VMs & containers monthly",
    startedAt: "2026-11-04T10:00:00.000Z",
    cancelling: false,
    progress: {
      bytesDone: 50,
      bytesTotal: 100,
      bytesUploaded: null,
      bytesPerSecond: 10,
      at: "2026-11-04T10:00:05.000Z",
    },
    ...over,
  };
}

describe("the runs of a Proxmox VE job", () => {
  it("takes the backups whose job id is the job's, not one asked for by hand", () => {
    expect(isRunOfPveJob(pveRun(), JOB)).toBe(true);
    expect(isRunOfPveJob(pveRun({ jobId: null }), JOB)).toBe(false);
    expect(isRunOfPveJob(pveRun({ jobId: "pj-2" }), JOB)).toBe(false);
    // A boot test the job started is not part of its backup round.
    expect(isRunOfPveJob(pveRun({ kind: "boot_test" }), JOB)).toBe(false);
  });

  it("matches by the job's name where an older server names no job id", () => {
    const { jobId: _jobId, ...legacy } = pveRun();
    expect(isRunOfPveJob(legacy, JOB)).toBe(true);
    expect(isRunOfPveJob({ ...legacy, jobName: "Nightly" }, JOB)).toBe(false);
  });

  it("lists them the one started first first, and none before the channel's snapshot", () => {
    const runs = {
      b: pveRun({ id: "b", startedAt: "2026-11-04T10:05:00.000Z" }),
      a: pveRun({ id: "a", startedAt: "2026-11-04T10:01:00.000Z" }),
      other: pveRun({ id: "other", jobId: "pj-2" }),
    };
    expect(runsOfPveJob(runs, JOB).map((run) => run.id)).toEqual(["a", "b"]);
    expect(runsOfPveJob(null, JOB)).toEqual([]);
  });
});

describe("how far a Proxmox VE job's round is", () => {
  const round = { total: 19, done: 3, running: 2 };

  it("counts the guests done and the share of the running ones", () => {
    expect(pveRoundPercent(round)).toBe(15);
    expect(pveRoundPercent(round, [pveRun()])).toBe(18);
    // A guest without a total adds nothing; nothing goes past the guests that run.
    expect(runShare(pveRun({ progress: null }))).toBeNull();
    expect(pveRoundPercent({ total: 4, done: 1, running: 1 }, [pveRun(), pveRun(), pveRun()])).toBe(
      50,
    );
    expect(pveRoundPercent({ total: 100, done: 57, running: 0 })).toBe(57);
    expect(pveRoundPercent({ total: 0, done: 0, running: 0 })).toBeNull();
  });

  it("moves the job row's percent with the live runs", () => {
    const job = { ...JOB, round: { since: "", ...round, failed: 0, queued: 14 } } as PveJob;
    const row = { rowType: "pve" as const, id: "pve:pj-1", name: job.name, job };
    expect(jobActivity(row, {}).percent).toBe(15);
    expect(jobActivity(row, {}, { "run-1": pveRun() }).percent).toBe(18);
  });

  it("gives a backup asked for by hand its own percent", () => {
    const guest = {
      id: "g-3",
      activity: "running",
      progress: pveRun().progress,
    } as unknown as PveGuest;
    const row = { rowType: "manual" as const, id: "pve-guest:g-3", name: "Manual", guest };
    expect(jobActivity(row, {}).percent).toBe(50);
  });
});

describe("the activity of a copy job", () => {
  it("follows its copy runs, which are restores of what it copies", () => {
    const job = mailJob({ id: "copy-1", kind: "copy" });
    const copying = liveRun({
      id: "copy-run",
      source: "file_share",
      kind: "restore",
      type: "copy",
      job: { id: "copy-1", name: "Copy" },
    });
    const activity = jobActivity(job, { [copying.id]: copying });
    expect(activity.running).toBe(1);
    expect(activity.lead?.id).toBe("copy-run");
    // A mail job's restores are not its backups.
    const restore = { ...copying, type: "restore", job: { id: job.id, name: "Mail" } };
    expect(jobActivity(mailJob({ id: "copy-1" }), { [restore.id]: restore }).lead).toBeNull();
  });
});
