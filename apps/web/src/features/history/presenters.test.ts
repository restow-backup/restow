import { describe, expect, it } from "vitest";

import type { Run, RunEvent } from "./api";
import {
  barPercent,
  checkView,
  eventView,
  historySearchOf,
  isMailSubject,
  isRunCategory,
  parseHistorySearch,
  runDurationSeconds,
  savingsPercent,
  stateView,
  waveProgress,
  withRun,
} from "./presenters";

const ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("stateView", () => {
  const view = (overrides: Partial<Pick<Run, "state" | "kind" | "checkIncomplete">>) =>
    stateView({ state: "succeeded", kind: "backup", checkIncomplete: false, ...overrides });

  it("is Lapis and pulsing while a run runs", () => {
    expect(view({ state: "running" })).toEqual({ key: "running", tone: "info", live: true });
  });

  it("never paints a backup that merely completed green: no restore check has read it back", () => {
    expect(view({ state: "succeeded", kind: "backup" })).toMatchObject({
      key: "succeeded",
      tone: "neutral",
    });
    expect(view({ state: "succeeded", kind: "restore_check" })).toMatchObject({ tone: "neutral" });
    expect(view({ state: "succeeded", kind: "maintenance" })).toMatchObject({ tone: "neutral" });
    // A restore that completed brought the data back: proof.
    expect(view({ state: "succeeded", kind: "restore" })).toMatchObject({
      key: "restored",
      tone: "success",
    });
  });

  it("warns for a partial run and fails for a failed one", () => {
    expect(view({ state: "partial" })).toMatchObject({ key: "partial", tone: "warning" });
    expect(view({ state: "failed" })).toMatchObject({ key: "failed", tone: "destructive" });
    expect(view({ state: "cancelled" })).toMatchObject({ key: "cancelled", tone: "muted" });
    expect(view({ state: "queued" })).toMatchObject({ key: "queued", tone: "muted", live: false });
  });

  it("calls a restore check that could not complete neutral information, never a failure", () => {
    expect(view({ state: "failed", kind: "restore_check", checkIncomplete: true })).toMatchObject({
      key: "incomplete",
      tone: "info",
    });
    // While it is running or waiting for its retry the state itself speaks.
    expect(view({ state: "running", checkIncomplete: true }).key).toBe("running");
    expect(view({ state: "queued", checkIncomplete: true }).key).toBe("queued");
  });
});

describe("checkView", () => {
  it("is green only for a check that passed", () => {
    expect(checkView({ state: "passed" }).tone).toBe("success");
    for (const state of ["warning", "failed", "running", "queued", "unverified", "none"] as const) {
      expect(checkView({ state }).tone).not.toBe("success");
    }
    expect(checkView({ state: "warning" }).tone).toBe("warning");
    expect(checkView({ state: "failed" }).tone).toBe("destructive");
    expect(checkView({ state: "running" }).tone).toBe("info");
  });
});

describe("numbers", () => {
  it("measures a run from its start to its end, or to now while it runs", () => {
    const now = Date.parse("2026-10-02T10:10:00.000Z");
    expect(
      runDurationSeconds({ startedAt: "2026-10-02T10:00:00.000Z", finishedAt: null }, now),
    ).toBe(600);
    expect(
      runDurationSeconds(
        { startedAt: "2026-10-02T10:00:00.000Z", finishedAt: "2026-10-02T10:01:30.000Z" },
        now,
      ),
    ).toBe(90);
    expect(runDurationSeconds({ startedAt: null, finishedAt: null }, now)).toBeNull();
    expect(runDurationSeconds({ startedAt: "nonsense", finishedAt: null }, now)).toBeNull();
  });

  it("fills a bar by percent, full for a completed run, empty before it begins, unknown while it discovers", () => {
    const progress = (percent: number | null) => ({ percent }) as Run["progress"];
    expect(barPercent({ state: "running", progress: progress(40) })).toBe(40);
    expect(barPercent({ state: "running", progress: progress(140) })).toBe(100);
    expect(barPercent({ state: "running", progress: progress(null) })).toBeNull();
    expect(barPercent({ state: "running", progress: null })).toBeNull();
    expect(barPercent({ state: "succeeded", progress: null })).toBe(100);
    expect(barPercent({ state: "partial", progress: progress(null) })).toBe(100);
    expect(barPercent({ state: "queued", progress: null })).toBe(0);
    expect(barPercent({ state: "failed", progress: progress(30) })).toBe(30);
  });

  it("says how much of what was read did not have to be written", () => {
    expect(savingsPercent(1000, 100)).toBe(90);
    expect(savingsPercent(1000, 1000)).toBe(0);
    expect(savingsPercent(1000, 5000)).toBe(0);
    // Never claims everything was saved.
    expect(savingsPercent(1_000_000, 0)).toBe(99.9);
    expect(savingsPercent(0, 0)).toBeNull();
  });

  it("counts a wave as finished by what is no longer queued or running", () => {
    expect(waveProgress({ total: 4, queued: 1, running: 1 })).toEqual({ done: 2, total: 4 });
    expect(waveProgress({ total: 1, queued: 0, running: 1 })).toBeNull();
    expect(waveProgress(null)).toBeNull();
  });

  it("tells a subject that lives in a mailbox from a machine", () => {
    expect(isMailSubject("mailbox")).toBe(true);
    expect(isMailSubject("onedrive")).toBe(true);
    expect(isMailSubject("server")).toBe(false);
  });
});

describe("eventView", () => {
  const event = (type: RunEvent["type"], params: RunEvent["params"] = {}) =>
    eventView({ type, params });

  it("words the lines of a timeline with what the server named", () => {
    expect(event("started", { full: false })).toEqual({ key: "started", values: {} });
    expect(event("started", { full: true }).key).toBe("startedFull");
    expect(event("phase", { phase: "download" })).toEqual({
      key: "phase",
      values: { phase: "download" },
    });
    expect(event("throttled", { status: 429, waitMs: 32_000 })).toEqual({
      key: "throttled",
      values: { status: 429, seconds: 32 },
    });
    expect(event("item_failed", { item: "AAMk", reason: "gone" }).values).toEqual({
      item: "AAMk",
      reason: "gone",
    });
    expect(event("completed", { itemsWritten: 12, itemsTotal: 40, failed: 0 })).toEqual({
      key: "completedItems",
      values: { written: 12, total: 40, failed: 0 },
    });
    expect(event("completed", { itemsWritten: 12, itemsTotal: 40, failed: 3 }).key).toBe(
      "completedWithFailures",
    );
    expect(event("completed", { itemsWritten: null, failed: 0 }).key).toBe("completed");
    expect(event("failed", { message: "boom" })).toEqual({
      key: "failedWithReason",
      values: { reason: "boom" },
    });
    expect(event("failed", { message: null }).key).toBe("failed");
    expect(event("agent_error", { path: "/srv/x", message: "denied" }).key).toBe("agentErrorPath");
    expect(event("agent_error", { path: null, message: "denied" }).key).toBe("agentError");
    expect(event("finished", { filesNew: 3, filesChanged: 2, state: "succeeded" })).toEqual({
      key: "finishedFiles",
      values: { files: 5, state: "succeeded" },
    });
    expect(event("finished", {}).key).toBe("finished");
    expect(event("restore_check_passed")).toEqual({ key: "restore_check_passed", values: {} });
    expect(event("queued").key).toBe("queued");
  });
});

describe("the address", () => {
  it("reads the tab, the job and the open run, and ignores anything else", () => {
    expect(parseHistorySearch({ type: "backup", job: ID, run: ID, junk: "x" })).toEqual({
      type: "backup",
      job: ID,
      run: ID,
    });
    expect(parseHistorySearch({ type: "bogus", job: "not-an-id", run: 5 })).toEqual({
      type: null,
      job: null,
      run: null,
    });
    expect(parseHistorySearch({})).toEqual({ type: null, job: null, run: null });
    expect(isRunCategory("restore_check")).toBe(true);
    expect(isRunCategory("verify")).toBe(false);
  });

  it("writes only what is set", () => {
    expect(historySearchOf({ type: "export", job: null, run: null })).toEqual({ type: "export" });
    expect(historySearchOf({})).toEqual({});
    expect(historySearchOf({ type: "backup", job: ID, run: ID })).toEqual({
      type: "backup",
      job: ID,
      run: ID,
    });
  });

  it("opens and closes the drawer without touching the rest of the address", () => {
    expect(withRun({ type: "backup" }, ID)).toEqual({ type: "backup", run: ID });
    expect(withRun({ type: "backup", run: "old" }, ID)).toEqual({ type: "backup", run: ID });
    expect(withRun({ type: "backup", run: ID }, null)).toEqual({ type: "backup" });
    expect(withRun({}, null)).toEqual({});
  });
});
