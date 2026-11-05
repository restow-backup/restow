import { describe, expect, it } from "vitest";
import { type BaremetalReadinessInput, baremetalReadiness } from "./readiness.js";

const base: BaremetalReadinessInput = {
  enabled: true,
  os: "linux",
  arch: "amd64",
  virtualization: null,
  agentTooOld: false,
  latestLayout: { verdict: "supported" },
  latestReport: null,
};

describe("baremetalReadiness (docs/BAREMETAL.md 12.4, up to M2)", () => {
  it("not_enabled: in no job with a whole machine backup and no layout", () => {
    expect(baremetalReadiness({ ...base, enabled: false, latestLayout: null })).toEqual({
      state: "not_enabled",
      notPossible: null,
      detail: null,
    });
  });

  it.each([
    [{ os: "windows" }, "windows"],
    [{ os: "darwin" }, "darwin_later"],
    [{ virtualization: "container" }, "container"],
    [{ arch: "arm64" }, "arm64_later"],
    [{ agentTooOld: true }, "agent_too_old"],
    [{ latestLayout: { verdict: "unsupported" } }, "unsupported"],
  ] as const)("not_possible %#: %s", (change, reason) => {
    expect(baremetalReadiness({ ...base, ...change })).toEqual({
      state: "not_possible",
      notPossible: reason,
      detail: null,
    });
  });

  it("an old agent matters only when the machine is backed up as a whole", () => {
    expect(
      baremetalReadiness({ ...base, enabled: false, agentTooOld: true, latestLayout: null }).state,
    ).toBe("not_enabled");
  });

  it("no_layout: enabled, but no snapshot with a manifest yet", () => {
    expect(baremetalReadiness({ ...base, latestLayout: null }).state).toBe("no_layout");
  });

  it("unverified: stage 1 for the newest snapshot is missing or still running", () => {
    expect(baremetalReadiness(base)).toEqual({
      state: "unverified",
      notPossible: null,
      detail: null,
    });
  });

  it("unverified with detail incomplete: stage 1 could not finish (yellow report)", () => {
    expect(baremetalReadiness({ ...base, latestReport: { readiness: "yellow" } })).toEqual({
      state: "unverified",
      notPossible: null,
      detail: "incomplete",
    });
  });

  it("layout_checked: stage 1 green, no boot probe before M5", () => {
    expect(baremetalReadiness({ ...base, latestReport: { readiness: "green" } }).state).toBe(
      "layout_checked",
    );
  });

  it("red: stage 1 of the newest snapshot red", () => {
    expect(baremetalReadiness({ ...base, latestReport: { readiness: "red" } }).state).toBe("red");
  });

  it("not_possible wins over a red report of an unsupported layout", () => {
    expect(
      baremetalReadiness({
        ...base,
        latestLayout: { verdict: "unsupported" },
        latestReport: { readiness: "red" },
      }),
    ).toEqual({ state: "not_possible", notPossible: "unsupported", detail: null });
  });

  it("never produces green or overdue before the boot probe", () => {
    for (const readiness of ["green", "yellow", "red", null] as const) {
      const { state } = baremetalReadiness({ ...base, latestReport: { readiness } });
      expect(["green", "overdue"]).not.toContain(state);
    }
  });
});
