import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import type { EndpointSummary } from "./api.js";
import "./i18n.js";
import { MACHINE_STATUS_ORDER, machineStatuses } from "./machine-status.js";

/**
 * A machine whose newest backup recorded no sample files (every Windows backup before agent
 * 0.5.0) can never be restore-checked: it is amber with that reason, never the quiet
 * "unverified" that waits for a check that does not come, and never green.
 */

function machine(readiness: Partial<EndpointSummary["readiness"]>) {
  return {
    status: "active",
    connection: "online",
    agentState: "idle",
    lastBackupAt: "2026-11-03T22:00:00.000Z",
    latestRun: null,
    readiness: {
      state: "unverified",
      checkedAt: null,
      overdue: false,
      basis: null,
      latestSnapshotId: "s1",
      ...readiness,
    },
    attention: [],
    job: { id: "j1", name: "Nightly" },
  } as unknown as Parameters<typeof machineStatuses>[0];
}

describe("the state of a machine without sample files", () => {
  it("is amber with its reason instead of unverified", () => {
    const keys = machineStatuses(machine({ noSamples: true })).map((s) => s.key);
    expect(keys).toContain("no_samples");
    expect(keys).not.toContain("unverified");
    expect(keys).not.toContain("verified");
    const status = machineStatuses(machine({ noSamples: true })).find(
      (s) => s.key === "no_samples",
    );
    expect(status).toMatchObject({ tone: "warning", problem: true });
  });

  it("stays unverified when samples were recorded or an older server says nothing", () => {
    for (const readiness of [{ noSamples: false }, {}]) {
      const keys = machineStatuses(machine(readiness)).map((s) => s.key);
      expect(keys).toContain("unverified");
      expect(keys).not.toContain("no_samples");
    }
  });

  it("has a label in both languages", () => {
    expect(MACHINE_STATUS_ORDER).toContain("no_samples");
    expect(i18n.t("endpoints:machineStatus.no_samples", { lng: "en" })).toBe(
      "No restore check possible",
    );
    expect(i18n.t("endpoints:machineStatus.no_samples", { lng: "de" })).toBe(
      "Keine Restore-Prüfung möglich",
    );
  });
});
