import { describe, expect, it } from "vitest";

import type { EndpointDetail } from "./api";
import { stoppableBackup } from "./endpoint-detail-page";
import { runStatusView, taskStatusView } from "./presenters";

/** What the machine page offers to stop (0.4.2), and how a cancelled run and task look. */

type Runs = EndpointDetail["runs"];
type Tasks = EndpointDetail["tasks"];

const run = (over: Partial<Runs[number]>): Runs[number] =>
  ({ id: "r-1", kind: "backup", status: "running", ...over }) as Runs[number];
const task = (over: Partial<Tasks[number]>): Tasks[number] =>
  ({ id: "t-1", kind: "backup_now", status: "pending", ...over }) as Tasks[number];

describe("stoppableBackup", () => {
  it("stops the running backup first, then a queued one", () => {
    expect(stoppableBackup({ runs: [run({})], tasks: [task({})] })).toEqual({
      activity: "running",
      cancelling: false,
      by: null,
    });
    expect(
      stoppableBackup({
        runs: [run({ status: "succeeded" })],
        tasks: [task({ status: "delivered" })],
      }),
    ).toEqual({ activity: "queued", cancelling: false, by: null });
  });

  it("says when the stop was asked for already, and by whom", () => {
    expect(
      stoppableBackup({
        runs: [run({ cancelRequestedAt: "2026-10-21T10:00:00Z", cancelledBy: "a@b.example" })],
        tasks: [],
      }),
    ).toEqual({ activity: "running", cancelling: true, by: "a@b.example" });
  });

  it("offers nothing for a restore or a finished request", () => {
    expect(
      stoppableBackup({
        runs: [run({ kind: "restore" })],
        tasks: [task({ status: "cancelled" }), task({ kind: "restore" })],
      }),
    ).toBeNull();
  });
});

describe("a cancelled run and task", () => {
  it("are neutral, never a failure, never green", () => {
    expect(runStatusView("cancelled", "backup")).toEqual({
      tone: "muted",
      key: "runStatus.cancelled",
      live: false,
    });
    expect(taskStatusView({ kind: "restore", status: "cancelled" }, { state: "done" }).tone).toBe(
      "neutral",
    );
  });
});
