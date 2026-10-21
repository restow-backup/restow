import de from "@restow/i18n/resources/de/pve.json" with { type: "json" };
import en from "@restow/i18n/resources/en/pve.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import type { PveGuest } from "./api";
import {
  GUEST_STATUS_META,
  GUEST_STATUS_ORDER,
  guestStatuses,
  matchesStateFilter,
  primaryStatus,
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

  it("shows a restore check state it does not know yet as postponed, amber (pve-locks)", () => {
    expect(verifyStatusKey({ state: "locked" as never })).toBe("verify_postponed");
    const status = primaryStatus(
      testGuest({
        lastVerify: { state: "postponed" as never, checkedAt: null, errors: [], requested: false },
      }),
    );
    expect(status).toEqual({ key: "verify_postponed", tone: "warning", problem: true });
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
