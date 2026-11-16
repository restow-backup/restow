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

describe("baremetalReadiness (docs/BAREMETAL.md 12.4)", () => {
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

  it("layout_checked: stage 1 green and no boot probe counted (no lab)", () => {
    expect(baremetalReadiness({ ...base, latestReport: { readiness: "green" } })).toEqual({
      state: "layout_checked",
      notPossible: null,
      detail: null,
      probe: { reason: "no_lab", checkedAt: null },
    });
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

  it("never produces green or overdue without a boot probe [READY-015]", () => {
    for (const readiness of ["green", "yellow", "red", null] as const) {
      const { state } = baremetalReadiness({ ...base, latestReport: { readiness } });
      expect(["green", "overdue"]).not.toContain(state);
    }
  });
});

describe("baremetalReadiness with the boot probe (12.4) [READY-014]", () => {
  const NOW = new Date("2026-11-12T12:00:00Z");
  const DAY = 24 * 3_600_000;
  const probe = (readiness: "green" | "red" | null, days: number) => ({
    readiness,
    layoutFingerprint: "L",
    bootChainFingerprint: "B",
    checkedAt: new Date(NOW.getTime() - days * DAY),
  });
  const withProbes = (
    probes: ReturnType<typeof probe>[],
    stage1: "green" | "yellow" | "red" | null = "green",
  ) =>
    baremetalReadiness({
      ...base,
      latestReport: { readiness: stage1 },
      now: NOW,
      probe: { probes, notPossible: null, lab: { present: true, kvm: true }, pending: null },
    });

  it("green only with stage 1 green and a green probe of the same fingerprints, at most 8 days old", () => {
    expect(withProbes([probe("green", 2)])).toEqual({
      state: "green",
      notPossible: null,
      detail: null,
      probe: { reason: null, checkedAt: new Date(NOW.getTime() - 2 * DAY) },
    });
    expect(withProbes([probe("green", 9)]).state).toBe("overdue");
    expect(withProbes([probe("red", 1), probe("green", 2)]).state).toBe("red");
  });

  it("a red or unfinished stage 1 of the newest snapshot wins over any probe", () => {
    expect(withProbes([probe("green", 1)], "red").state).toBe("red");
    expect(withProbes([probe("green", 1)], "yellow").state).toBe("unverified");
    expect(withProbes([probe("green", 1)], null).state).toBe("unverified");
  });

  it("a changed boot chain (no probe for the new fingerprints) is layout_checked again", () => {
    expect(withProbes([]).state).toBe("layout_checked");
  });
});
