import de from "@restow/i18n/resources/de/pve.json" with { type: "json" };
import en from "@restow/i18n/resources/en/pve.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import type { PveGuest } from "./api";
import {
  GUEST_STATUS_META,
  GUEST_STATUS_ORDER,
  type GuestStatus,
  guestStatuses,
  matchesStateFilter,
  primaryStatus,
  statusRank,
  verifyStatusKey,
} from "./guest-status";

/** The one state mapping of VMs & containers (0.4.3): which badge a row shows, and the filters. */

function testGuest(over: Partial<PveGuest> = {}): PveGuest {
  return {
    id: "g-1",
    clusterId: "c-1",
    vmid: 200,
    kind: "ct",
    name: "web",
    node: "pmx02",
    status: "running",
    template: false,
    privileged: false,
    present: true,
    diskBytes: 0,
    jobId: "j-1",
    jobName: "Nightly",
    lastBackupAt: "2026-10-20T01:00:00Z",
    lastSuccessAt: "2026-10-20T01:00:00Z",
    lastRunStatus: "succeeded",
    lastRunError: null,
    bitmapState: null,
    attention: [],
    ...over,
  } as PveGuest;
}

const keys = (g: PveGuest, node?: Parameters<typeof guestStatuses>[1]) =>
  guestStatuses(g, node).map((s) => s.key);

describe("guest states", () => {
  it("shows a plain successful backup as backed up, neutral, never green", () => {
    const status = primaryStatus(testGuest());
    expect(status.key).toBe("succeeded");
    expect(status.tone).toBe("outline");
  });

  it("is green only for a restore check that passed", () => {
    for (const key of GUEST_STATUS_ORDER) {
      expect(GUEST_STATUS_META[key].tone === "success").toBe(key === "verified");
    }
    expect(
      primaryStatus(
        testGuest({
          lastVerify: { state: "green", checkedAt: null, errors: [], requested: false },
        }),
      ).key,
    ).toBe("verified");
  });

  it("puts what runs now first, then failures, then warnings", () => {
    const g = testGuest({
      activity: "running",
      lastRunStatus: "failed",
      lastVerify: { state: "red", checkedAt: null, errors: ["x"], requested: false },
    });
    expect(keys(g)).toEqual(["running", "failed", "verify_failed"]);
    expect(keys(testGuest({ activity: "running", cancelling: true }))[0]).toBe("cancelling");
    expect(keys(testGuest({ lastRunWarnings: ["WARN"] }))).toEqual(["warnings"]);
  });

  it("calls waiting for a disconnected or paused node a problem, plain waiting not", () => {
    const queued = testGuest({ activity: "queued" });
    expect(primaryStatus(queued, { online: true, queuePausedAt: null }).key).toBe("waiting");
    expect(primaryStatus(queued, { online: false, queuePausedAt: null }).key).toBe(
      "waiting_offline",
    );
    expect(primaryStatus(queued, { online: true, queuePausedAt: "x" }).problem).toBe(true);
  });

  it("knows guests that are not protected", () => {
    expect(
      primaryStatus(
        testGuest({ jobId: null, lastSuccessAt: null, lastRunStatus: null, attention: ["no_job"] }),
      ).key,
    ).toBe("no_job");
    expect(primaryStatus(testGuest({ lastSuccessAt: null, lastRunStatus: null })).key).toBe(
      "never",
    );
    expect(primaryStatus(testGuest({ kind: "vm", template: true, lastRunStatus: null })).key).toBe(
      "template",
    );
  });

  it("shows a guest excluded from backup as excluded, never as a problem", () => {
    const statuses = guestStatuses(
      testGuest({
        jobId: null,
        lastSuccessAt: null,
        lastRunStatus: "failed",
        attention: [],
        excludedAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    expect(statuses[0]?.key).toBe("excluded");
    expect(statuses.map((status) => status.key)).not.toContain("never");
    expect(statuses.some((status) => status.problem)).toBe(false);
    expect(matchesStateFilter(statuses, "excluded")).toBe(true);
    expect(matchesStateFilter(statuses, "problems")).toBe(false);
    expect(matchesStateFilter(statuses, "failed")).toBe(false);
    const succeeded = guestStatuses(
      testGuest({ lastRunStatus: "succeeded", excludedAt: "2026-10-01T00:00:00.000Z" }),
    );
    expect(matchesStateFilter(succeeded, "ok")).toBe(false);
    // It sorts after a failure, though its badge leads its own row.
    const failed = primaryStatus(testGuest({ lastRunStatus: "failed" }));
    expect(statusRank(statuses[0] as GuestStatus)).toBeGreaterThan(statusRank(failed));
  });

  it("shows a restore check that could not run as amber, never green or red", () => {
    const notChecked = (gaveUp: boolean) => ({
      reason: "locked" as const,
      detail: "repository is already locked by PID 7 on pve1 by root",
      attempts: 12,
      gaveUp,
    });
    // The worker gave up after two hours: the API says yellow.
    const gaveUp = guestStatuses(
      testGuest({
        lastVerify: {
          state: "yellow",
          checkedAt: "2026-10-20T10:00:00.000Z",
          errors: [],
          requested: false,
          notChecked: notChecked(true),
        },
      }),
    );
    expect(gaveUp[0]).toEqual({ key: "verify_not_checked", tone: "warning", problem: true });
    expect(gaveUp.map((s) => s.key)).not.toContain("verified");
    expect(gaveUp.map((s) => s.key)).not.toContain("verify_failed");
    expect(matchesStateFilter(gaveUp, "verify")).toBe(true);
    expect(matchesStateFilter(gaveUp, "problems")).toBe(true);
    expect(matchesStateFilter(gaveUp, "ok")).toBe(false);

    // Still tried again, nothing checked before: postponed, amber, not yet a problem.
    const postponed = guestStatuses(
      testGuest({
        lastVerify: {
          state: null,
          checkedAt: null,
          errors: [],
          requested: false,
          notChecked: notChecked(false),
        },
      }),
    );
    expect(postponed[0]).toEqual({ key: "verify_postponed", tone: "warning", problem: false });
    expect(postponed.map((s) => s.key)).not.toContain("verified");

    // Still tried again, an earlier check passed: that proof stands beside the amber note.
    const keys = guestStatuses(
      testGuest({
        lastVerify: {
          state: "green",
          checkedAt: "2026-10-20T10:00:00.000Z",
          errors: [],
          requested: false,
          notChecked: notChecked(false),
        },
      }),
    ).map((s) => s.key);
    expect(keys).toContain("verify_postponed");
    expect(keys).toContain("verified");
    expect(keys.indexOf("verify_postponed")).toBeLessThan(keys.indexOf("verified"));
  });

  it("shows a restore check state it does not know yet as not checked, amber", () => {
    expect(verifyStatusKey({ state: "locked" as never })).toBe("verify_not_checked");
    const status = primaryStatus(
      testGuest({
        lastVerify: { state: "postponed" as never, checkedAt: null, errors: [], requested: false },
      }),
    );
    expect(status).toEqual({ key: "verify_not_checked", tone: "warning", problem: true });
  });

  it("filters by group and by problems", () => {
    const failed = guestStatuses(testGuest({ lastRunStatus: "failed" }));
    const fine = guestStatuses(testGuest());
    expect(matchesStateFilter(failed, "problems")).toBe(true);
    expect(matchesStateFilter(failed, "failed")).toBe(true);
    expect(matchesStateFilter(fine, "problems")).toBe(false);
    expect(matchesStateFilter(fine, "ok")).toBe(true);
    expect(matchesStateFilter(failed, "ok")).toBe(false);
    const red = guestStatuses(
      testGuest({ lastVerify: { state: "red", checkedAt: null, errors: [], requested: false } }),
    );
    expect(matchesStateFilter(red, "verify")).toBe(true);
  });

  it("has a label for every state in both languages", () => {
    const labels = (resource: unknown) =>
      (resource as { guests: { status: Record<string, string> } }).guests.status;
    for (const key of GUEST_STATUS_ORDER) {
      expect(labels(en)[key], key).toBeTruthy();
      expect(labels(de)[key], key).toBeTruthy();
    }
  });
});
