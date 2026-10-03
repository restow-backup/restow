import { describe, expect, it } from "vitest";
import {
  type Run,
  type StateView,
  pendingSteps,
  publicStatusOf,
  runSchema,
} from "../../updater/protocol.js";
import { maintenanceViewOf, toRunView } from "./views.js";

function runOf(switchTo: "full" | null): Run {
  return runSchema.parse({
    id: "r-1",
    mode: "image",
    switchTo,
    fromVersion: "0.2.1",
    targetVersion: "0.2.1",
    targetTag: "v0.2.1",
    releaseUrl: null,
    requestedBy: { userId: "u1", label: "admin@example.com", ip: "203.0.113.7" },
    scheduledAt: "2026-10-01T10:00:00.000Z",
    leadSeconds: 300,
    startsAt: "2026-10-01T10:05:00.000Z",
    steps: pendingSteps(),
    images: { app: null, web: null },
  });
}

const NOW = new Date("2026-10-01T10:01:00.000Z");

function stateOf(run: Run): StateView {
  return { run, phase: "scheduled", history: [] } as unknown as StateView;
}

describe("the maintenance view of a build switch", () => {
  it("names the switch next to the versions for signed-in users", () => {
    const view = maintenanceViewOf(stateOf(runOf("full")), "0.2.1", NOW);
    expect(view).toMatchObject({
      phase: "scheduled",
      switchTo: "full",
      targetVersion: "0.2.1",
      runningVersion: "0.2.1",
    });
  });

  it("has no switch for a normal update or while nothing is announced", () => {
    expect(maintenanceViewOf(stateOf(runOf(null)), "0.2.0", NOW).switchTo).toBeNull();
    expect(maintenanceViewOf(null, "0.2.0", NOW).switchTo).toBeNull();
  });

  it("keeps the public status as minimal as it was: no version, no switch", () => {
    const status = publicStatusOf(runOf("full"), "scheduled", NOW);
    expect(status).not.toHaveProperty("switchTo");
    expect(status).not.toHaveProperty("targetVersion");
    expect(status).not.toHaveProperty("fromVersion");
  });

  it("carries the switch in the run an administrator sees", () => {
    expect(toRunView(runOf("full")).switchTo).toBe("full");
    expect(toRunView(runOf(null)).switchTo).toBeNull();
  });
});
