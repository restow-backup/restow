import { describe, expect, it } from "vitest";

import {
  OUTCOMES,
  PHASES,
  type PageStatus,
  RELOAD_BACKOFF_MS,
  STEP_IDS,
  currentStep,
  failureAttribute,
  failureView,
  fill,
  modeOf,
  parseStatus,
  shouldReload,
  stepStatuses,
} from "./client";

/** The decisions of the static maintenance page: what a status means and when to reload. */

function status(overrides: Partial<PageStatus> = {}): PageStatus {
  return {
    phase: "running",
    outcome: null,
    targetVersion: "0.2.0",
    step: "fetch",
    steps: [
      { id: "prepare", status: "done" },
      { id: "fetch", status: "running" },
    ],
    progress: 30,
    failureCode: null,
    ...overrides,
  };
}

describe("parseStatus", () => {
  it("reads the public status the edge serves", () => {
    expect(
      parseStatus({
        phase: "running",
        runId: "r-1",
        outcome: null,
        targetVersion: "0.2.0",
        fromVersion: "0.1.0",
        step: "backup",
        steps: [
          { id: "prepare", status: "done" },
          { id: "backup", status: "running" },
        ],
        progress: 41.6,
        message: { code: "step.backup.dumping", params: {} },
        failureCode: null,
        serverTime: "2026-09-30T12:00:00.000Z",
      }),
    ).toEqual({
      phase: "running",
      outcome: null,
      targetVersion: "0.2.0",
      step: "backup",
      steps: [
        { id: "prepare", status: "done" },
        { id: "backup", status: "running" },
      ],
      progress: 42,
      failureCode: null,
    });
  });

  it("refuses everything that is not a status", () => {
    for (const payload of [null, undefined, "", "<html>", 3, [], {}, { phase: "nap" }]) {
      expect(parseStatus(payload), JSON.stringify(payload)).toBeNull();
    }
  });

  it("drops unknown steps, outcomes and junk, and bounds the progress", () => {
    const parsed = parseStatus({
      phase: "failed",
      outcome: "exploded",
      step: "nap",
      steps: [
        { id: "nap", status: "done" },
        { id: "fetch", status: "bogus" },
        null,
        "x",
        { id: "stop", status: "failed" },
      ],
      progress: 900,
      targetVersion: "",
      failureCode: 12,
    });
    expect(parsed).toEqual({
      phase: "failed",
      outcome: null,
      targetVersion: null,
      step: null,
      steps: [{ id: "stop", status: "failed" }],
      progress: 100,
      failureCode: null,
    });
    expect(parseStatus({ phase: "idle", progress: -3 })?.progress).toBe(0);
    expect(parseStatus({ phase: "idle", progress: Number.NaN })?.progress).toBe(0);
  });

  it("accepts every phase and outcome of the protocol", () => {
    for (const phase of PHASES) {
      expect(parseStatus({ phase })?.phase).toBe(phase);
    }
    for (const outcome of OUTCOMES) {
      expect(parseStatus({ phase: "failed", outcome })?.outcome).toBe(outcome);
    }
  });
});

describe("modeOf", () => {
  it("says what the page is about", () => {
    expect(modeOf(null)).toBe("unavailable");
    expect(modeOf(status({ phase: "idle" }))).toBe("unavailable");
    expect(modeOf(status({ phase: "scheduled" }))).toBe("scheduled");
    expect(modeOf(status({ phase: "running" }))).toBe("updating");
    expect(modeOf(status({ phase: "succeeded" }))).toBe("succeeded");
    expect(modeOf(status({ phase: "failed" }))).toBe("failed");
  });
});

describe("shouldReload", () => {
  const NOW = 1_000_000;
  const base = { now: NOW, lastReloadAt: null, guarded: true };

  it("reloads when the application answers and no update is announced or running", () => {
    expect(shouldReload({ ...base, status: null, ready: true })).toBe(true);
    expect(shouldReload({ ...base, status: status({ phase: "idle" }), ready: true })).toBe(true);
    expect(shouldReload({ ...base, status: status({ phase: "failed" }), ready: true })).toBe(true);
  });

  it("does not reload while the application does not answer", () => {
    expect(shouldReload({ ...base, status: null, ready: false })).toBe(false);
    expect(shouldReload({ ...base, status: status({ phase: "idle" }), ready: false })).toBe(false);
    expect(shouldReload({ ...base, status: status({ phase: "failed" }), ready: false })).toBe(
      false,
    );
  });

  it("waits for an announced or running update even if the application answers", () => {
    for (const phase of ["scheduled", "running"] as const) {
      expect(shouldReload({ ...base, status: status({ phase }), ready: true }), phase).toBe(false);
      expect(shouldReload({ ...base, status: status({ phase }), ready: false }), phase).toBe(false);
    }
  });

  it("reloads when the status says the update succeeded, ready or not", () => {
    expect(shouldReload({ ...base, status: status({ phase: "succeeded" }), ready: false })).toBe(
      true,
    );
    expect(shouldReload({ ...base, status: status({ phase: "succeeded" }), ready: true })).toBe(
      true,
    );
  });

  it("does not reload twice within the backoff", () => {
    const recent = { ...base, lastReloadAt: NOW - RELOAD_BACKOFF_MS + 1 };
    expect(shouldReload({ ...recent, status: status({ phase: "succeeded" }), ready: true })).toBe(
      false,
    );
    expect(shouldReload({ ...recent, status: null, ready: true })).toBe(false);
    const old = { ...base, lastReloadAt: NOW - RELOAD_BACKOFF_MS };
    expect(shouldReload({ ...old, status: null, ready: true })).toBe(true);
  });

  it("does not trust 'succeeded' alone when a reload cannot be remembered (it could loop)", () => {
    const unguarded = { ...base, guarded: false };
    expect(
      shouldReload({ ...unguarded, status: status({ phase: "succeeded" }), ready: false }),
    ).toBe(false);
    // A real answer of the application still counts.
    expect(
      shouldReload({ ...unguarded, status: status({ phase: "succeeded" }), ready: true }),
    ).toBe(true);
  });
});

describe("texts", () => {
  it("fills placeholders and leaves unknown ones", () => {
    expect(fill("Update to {version}", { version: "0.2.0" })).toBe("Update to 0.2.0");
    expect(fill("{a} and {b}", { a: "x" })).toBe("x and {b}");
    expect(fill("no placeholder", { a: "x" })).toBe("no placeholder");
    expect(fill("{constructor}", {})).toBe("{constructor}");
  });

  it("names the attribute of a failure code", () => {
    expect(failureAttribute("fetch.pull_failed")).toBe("data-failure-fetch-pull-failed");
    expect(failureAttribute("interrupted")).toBe("data-failure-interrupted");
    expect(failureAttribute("health.version_mismatch")).toBe(
      "data-failure-health-version-mismatch",
    );
  });

  it("picks the explanation of a failed run by its outcome", () => {
    const failed = (outcome: PageStatus["outcome"], failureCode: string | null = null) =>
      failureView(status({ phase: "failed", outcome, failureCode }));
    expect(failed("unchanged")).toEqual({ textKey: "failure-unchanged", reasonAttribute: null });
    expect(failed("rolled_back", "health.timeout")).toEqual({
      textKey: "failure-rolled-back",
      reasonAttribute: "data-failure-health-timeout",
    });
    expect(failed("needs_attention").textKey).toBe("failure-needs-attention");
    expect(failed(null).textKey).toBe("failure-generic");
  });
});

describe("steps", () => {
  it("lists every step, pending unless the status says otherwise", () => {
    const states = stepStatuses(status());
    expect(Object.keys(states)).toEqual([...STEP_IDS]);
    expect(states).toMatchObject({
      prepare: "done",
      fetch: "running",
      backup: "pending",
      finish: "pending",
    });
    expect(Object.values(stepStatuses(null)).every((value) => value === "pending")).toBe(true);
  });

  it("names the running step, else the step the status points at", () => {
    expect(currentStep(status())).toBe("fetch");
    expect(
      currentStep(status({ steps: [{ id: "prepare", status: "done" }], step: "backup" })),
    ).toBe("backup");
    expect(currentStep(status({ steps: [], step: null }))).toBeNull();
    expect(currentStep(null)).toBeNull();
  });
});
