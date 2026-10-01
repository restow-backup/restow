import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";

import type { MaintenanceView, PublicStatus } from "../api";
import { NOW, iso, maintenanceFixture } from "../testing";
import {
  ACTIVE_POLL_MS,
  IDLE_POLL_MS,
  type MaintenanceSnapshot,
  RELOAD_COOLDOWN_MS,
  STALE_FAILURE_MS,
  SUCCESS_RELOAD_DELAY_MS,
  bannerStateOf,
  decideReload,
  effectivePhase,
  isAnnouncement,
  isMaintenanceGap,
  modalStateOf,
  nextReloadRecord,
  pollIntervalMs,
  pollMaintenance,
  reloadIsBlocked,
  smoothOffset,
} from "./maintenance-state";

function snapshot(
  overrides: Partial<MaintenanceView> = {},
  extra: Partial<MaintenanceSnapshot> = {},
): MaintenanceSnapshot {
  return {
    view: maintenanceFixture(overrides),
    apiReachable: true,
    offsetMs: 0,
    offsetSamples: [0],
    receivedAt: NOW,
    ...extra,
  };
}

const gap = () => new NetworkError(new TypeError("Failed to fetch"));
const serverError = (status: number) => new ApiError(status, null, "failed");

describe("isMaintenanceGap", () => {
  it("reads a refused connection and a gateway in front of a stopped api as a restart", () => {
    expect(isMaintenanceGap(gap())).toBe(true);
    for (const status of [502, 503, 504]) {
      expect(isMaintenanceGap(serverError(status)), String(status)).toBe(true);
    }
  });

  it("does not excuse anything else", () => {
    for (const status of [400, 401, 403, 404, 500]) {
      expect(isMaintenanceGap(serverError(status)), String(status)).toBe(false);
    }
    expect(isMaintenanceGap(new Error("boom"))).toBe(false);
    expect(isMaintenanceGap(new TypeError("x"))).toBe(false);
  });
});

describe("pollMaintenance", () => {
  function deps(overrides: {
    api?: () => Promise<MaintenanceView>;
    edge?: () => Promise<PublicStatus | null>;
  }) {
    return {
      fetchApi: vi.fn(overrides.api ?? (async () => maintenanceFixture())),
      fetchEdge: vi.fn(overrides.edge ?? (async () => null)),
      now: () => NOW,
    };
  }

  it("takes the api's answer and measures the clock skew", async () => {
    const view = maintenanceFixture({ serverTime: iso(3600) });
    const result = await pollMaintenance(deps({ api: async () => view }), null);
    expect(result).toMatchObject({
      view,
      apiReachable: true,
      offsetMs: 3_600_000,
      receivedAt: NOW,
    });
  });

  it("does not ask the edge while the api answers", async () => {
    const d = deps({});
    await pollMaintenance(d, snapshot({ phase: "running" }));
    expect(d.fetchEdge).not.toHaveBeenCalled();
  });

  it("stays silent about a failure while nothing is going on", async () => {
    const d = deps({ api: async () => Promise.reject(gap()) });
    await expect(pollMaintenance(d, null)).rejects.toBeInstanceOf(NetworkError);
    await expect(pollMaintenance(d, snapshot({ phase: "idle" }))).rejects.toBeInstanceOf(
      NetworkError,
    );
    await expect(pollMaintenance(d, snapshot({ phase: "failed" }))).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(d.fetchEdge).not.toHaveBeenCalled();
  });

  it("treats a lost connection during a maintenance as maintenance in progress", async () => {
    for (const phase of ["scheduled", "running"] as const) {
      const previous = snapshot({ phase, runId: "r-1", targetVersion: "0.2.0", progress: 30 });
      const d = deps({ api: async () => Promise.reject(gap()) });
      const result = await pollMaintenance(d, previous);
      // It keeps what it knew and asks the edge as well.
      expect(result.apiReachable).toBe(false);
      expect(result.view).toEqual(previous.view);
      expect(d.fetchEdge).toHaveBeenCalledTimes(1);
    }
  });

  it("does the same for 502, 503 and 504", async () => {
    for (const status of [502, 503, 504]) {
      const d = deps({ api: async () => Promise.reject(serverError(status)) });
      const result = await pollMaintenance(d, snapshot({ phase: "running", runId: "r-1" }));
      expect(result.apiReachable, String(status)).toBe(false);
    }
  });

  it("still throws for an error that is not a restart, also during a maintenance", async () => {
    const d = deps({ api: async () => Promise.reject(serverError(500)) });
    await expect(pollMaintenance(d, snapshot({ phase: "running" }))).rejects.toBeInstanceOf(
      ApiError,
    );
    const unauthorized = deps({ api: async () => Promise.reject(serverError(401)) });
    await expect(
      pollMaintenance(unauthorized, snapshot({ phase: "running" })),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("merges the edge's status when the api is away", async () => {
    const edge: PublicStatus = {
      ...maintenanceFixture({
        phase: "running",
        runId: "r-1",
        step: "start",
        progress: 70,
        targetVersion: "0.2.0",
      }),
      serverTime: iso(2),
    };
    const { runningVersion: _ignored, ...publicStatus } = edge as MaintenanceView;
    const d = deps({ api: async () => Promise.reject(gap()), edge: async () => publicStatus });
    const result = await pollMaintenance(
      d,
      snapshot({ phase: "running", runId: "r-1", progress: 30 }),
    );
    expect(result.apiReachable).toBe(false);
    expect(result.view).toMatchObject({ phase: "running", step: "start", progress: 70 });
    // The api that answers no more reports no version.
    expect(result.view.runningVersion).toBeNull();
    expect(result.offsetMs).toBe(2000);
  });

  it("keeps the versions the api named for the same run, since the edge names none", async () => {
    const edge: PublicStatus = {
      ...maintenanceFixture({
        phase: "running",
        runId: "r-1",
        step: "health",
        progress: 80,
        message: { code: "step.health.waiting_for_api", params: {} },
      }),
      targetVersion: null,
      fromVersion: null,
      serverTime: iso(2),
    };
    const { runningVersion: _ignored, ...publicStatus } = edge as MaintenanceView;
    const previous = snapshot({
      phase: "running",
      runId: "r-1",
      targetVersion: "0.2.0",
      fromVersion: "0.1.0",
    });
    const d = deps({ api: async () => Promise.reject(gap()), edge: async () => publicStatus });
    const result = await pollMaintenance(d, previous);
    expect(result.view).toMatchObject({
      targetVersion: "0.2.0",
      fromVersion: "0.1.0",
      message: { code: "step.health.waiting_for_api", params: { version: "0.2.0" } },
    });
    // Another run's versions are not carried over.
    const other = await pollMaintenance(
      deps({
        api: async () => Promise.reject(gap()),
        edge: async () => ({ ...publicStatus, runId: "r-2" }),
      }),
      previous,
    );
    expect(other.view.targetVersion).toBeNull();
    expect(other.view.message?.params).toEqual({});
  });

  it("learns that the update finished from the edge while the api is still away", async () => {
    const edge = {
      ...maintenanceFixture({
        phase: "succeeded",
        runId: "r-1",
        outcome: "succeeded",
        progress: 100,
      }),
    } as PublicStatus;
    const d = deps({ api: async () => Promise.reject(gap()), edge: async () => edge });
    const result = await pollMaintenance(d, snapshot({ phase: "running", runId: "r-1" }));
    expect(result.view.phase).toBe("succeeded");
    expect(result.apiReachable).toBe(false);
  });

  it("ignores an idle edge (it also says idle when no updater runs) and a failing edge", async () => {
    const previous = snapshot({ phase: "running", runId: "r-1", progress: 30 });
    const idle = deps({
      api: async () => Promise.reject(gap()),
      edge: async () => maintenanceFixture() as PublicStatus,
    });
    expect((await pollMaintenance(idle, previous)).view).toEqual(previous.view);

    const failing = deps({ api: async () => Promise.reject(gap()), edge: async () => null });
    const result = await pollMaintenance(failing, previous);
    expect(result.view).toEqual(previous.view);
    expect(result.apiReachable).toBe(false);
  });

  it("keeps going through the gap after a phase the api no longer reports", async () => {
    // The edge said the run succeeded; the api is still away: not an error.
    const previous = snapshot({ phase: "succeeded", runId: "r-1" }, { apiReachable: false });
    const d = deps({ api: async () => Promise.reject(gap()) });
    const result = await pollMaintenance(d, previous);
    expect(result.apiReachable).toBe(false);
    expect(result.view.phase).toBe("succeeded");
    expect(d.fetchEdge).toHaveBeenCalled();
  });

  it("is back to normal as soon as the api answers", async () => {
    const previous = snapshot({ phase: "running", runId: "r-1" }, { apiReachable: false });
    const back = maintenanceFixture({ phase: "succeeded", runId: "r-1", runningVersion: "0.2.0" });
    const result = await pollMaintenance(deps({ api: async () => back }), previous);
    expect(result.apiReachable).toBe(true);
    expect(result.view.runningVersion).toBe("0.2.0");
  });
});

describe("smoothOffset", () => {
  it("takes the fastest answer of the last few, so the countdown does not jitter", () => {
    expect(smoothOffset(undefined, -40)).toEqual({ offsetMs: -40, samples: [-40] });
    expect(smoothOffset([-40, -90], -10).offsetMs).toBe(-10);
    expect(smoothOffset([-10, -90], -60).offsetMs).toBe(-10);
  });

  it("forgets old samples", () => {
    let samples: number[] | undefined;
    for (let index = 0; index < 20; index += 1) {
      samples = smoothOffset(samples, index === 0 ? 5000 : -index).samples;
    }
    expect(samples?.length).toBe(8);
    expect(smoothOffset(samples, -20).offsetMs).toBeLessThan(0);
  });
});

describe("pollIntervalMs", () => {
  it("rests when idle and follows an announced or running update closely", () => {
    expect(pollIntervalMs(undefined)).toBe(IDLE_POLL_MS);
    expect(pollIntervalMs(snapshot({ phase: "idle" }))).toBe(30_000);
    expect(pollIntervalMs(snapshot({ phase: "failed" }))).toBe(30_000);
    expect(pollIntervalMs(snapshot({ phase: "scheduled" }))).toBe(ACTIVE_POLL_MS);
    expect(pollIntervalMs(snapshot({ phase: "running" }))).toBe(2_000);
  });

  it("also polls closely while the api is away", () => {
    expect(pollIntervalMs(snapshot({ phase: "succeeded" }, { apiReachable: false }))).toBe(2_000);
  });
});

describe("effectivePhase", () => {
  it("is the phase the view reports", () => {
    expect(effectivePhase(snapshot({ phase: "running" }), NOW)).toBe("running");
    expect(effectivePhase(snapshot({ phase: "idle" }), NOW)).toBe("idle");
  });

  it("reads a countdown that ran out, with the api away, as the update having started", () => {
    const scheduled = { phase: "scheduled" as const, startsAt: iso(30) };
    expect(effectivePhase(snapshot(scheduled, { apiReachable: false }), NOW)).toBe("scheduled");
    expect(effectivePhase(snapshot(scheduled, { apiReachable: false }), NOW + 31_000)).toBe(
      "running",
    );
    // With the api answering, the api decides.
    expect(effectivePhase(snapshot(scheduled), NOW + 31_000)).toBe("scheduled");
  });

  it("counts on the server's clock", () => {
    const scheduled = snapshot(
      { phase: "scheduled", startsAt: iso(30) },
      { apiReachable: false, offsetMs: 60_000 },
    );
    expect(effectivePhase(scheduled, NOW)).toBe("running");
  });
});

describe("isAnnouncement", () => {
  it("is a change from calm (or a finished run) to scheduled, never the first look", () => {
    expect(isAnnouncement("idle", "scheduled")).toBe(true);
    expect(isAnnouncement("succeeded", "scheduled")).toBe(true);
    expect(isAnnouncement("failed", "scheduled")).toBe(true);
    expect(isAnnouncement(null, "scheduled")).toBe(false);
    expect(isAnnouncement("scheduled", "scheduled")).toBe(false);
    expect(isAnnouncement("running", "scheduled")).toBe(false);
    expect(isAnnouncement("idle", "running")).toBe(false);
    expect(isAnnouncement("scheduled", "idle")).toBe(false);
  });
});

describe("decideReload", () => {
  it("reloads at once when the api answers with another version than the page loaded with", () => {
    const view = snapshot({ phase: "succeeded", runId: "r-1", runningVersion: "0.2.0" });
    expect(decideReload({ snapshot: view, baselineVersion: "0.1.0", sawActiveRun: true })).toEqual({
      action: "reload",
      delayMs: 0,
      token: "version:0.2.0",
    });
    // Also without a maintenance (a manual update while the page was open).
    const quiet = snapshot({ phase: "idle", runningVersion: "0.2.0" });
    expect(
      decideReload({ snapshot: quiet, baselineVersion: "0.1.0", sawActiveRun: false }).action,
    ).toBe("reload");
  });

  it("does not reload when the version is unchanged or unknown", () => {
    const same = snapshot({ phase: "idle", runningVersion: "0.1.0" });
    expect(
      decideReload({ snapshot: same, baselineVersion: "0.1.0", sawActiveRun: false }).action,
    ).toBe("none");
    const unknown = snapshot({ phase: "idle", runningVersion: null });
    expect(
      decideReload({ snapshot: unknown, baselineVersion: "0.1.0", sawActiveRun: false }).action,
    ).toBe("none");
    expect(
      decideReload({ snapshot: same, baselineVersion: null, sawActiveRun: false }).action,
    ).toBe("none");
  });

  it("reloads after a moment when the run this page watched succeeded", () => {
    const view = snapshot({ phase: "succeeded", runId: "r-1", runningVersion: "0.1.0" });
    expect(decideReload({ snapshot: view, baselineVersion: "0.1.0", sawActiveRun: true })).toEqual({
      action: "reload",
      delayMs: SUCCESS_RELOAD_DELAY_MS,
      token: "run:r-1",
    });
  });

  it("does not reload a page that never saw the run (it loaded after the update)", () => {
    const view = snapshot({ phase: "succeeded", runId: "r-1", runningVersion: "0.2.0" });
    expect(
      decideReload({ snapshot: view, baselineVersion: "0.2.0", sawActiveRun: false }).action,
    ).toBe("none");
  });

  it("never reloads while the api is unreachable", () => {
    const view = snapshot(
      { phase: "succeeded", runId: "r-1", runningVersion: "0.2.0" },
      { apiReachable: false },
    );
    expect(
      decideReload({ snapshot: view, baselineVersion: "0.1.0", sawActiveRun: true }).action,
    ).toBe("none");
  });
});

describe("the reload guard", () => {
  it("blocks a token that was reloaded for, and any reload right after another", () => {
    expect(reloadIsBlocked(null, "version:0.2.0", NOW)).toBe(false);
    const record = nextReloadRecord(null, "version:0.2.0", NOW);
    expect(record).toEqual({ tokens: ["version:0.2.0"], at: NOW });
    expect(reloadIsBlocked(record, "version:0.2.0", NOW + 3_600_000)).toBe(true);
    // Another version change right after is flapping; the reload for the finished run is not.
    expect(reloadIsBlocked(record, "version:0.3.0", NOW + RELOAD_COOLDOWN_MS - 1)).toBe(true);
    expect(reloadIsBlocked(record, "version:0.3.0", NOW + RELOAD_COOLDOWN_MS + 1)).toBe(false);
    expect(reloadIsBlocked(record, "run:r-1", NOW + 1)).toBe(false);
    const afterRun = nextReloadRecord(record, "run:r-1", NOW + 3_000);
    expect(reloadIsBlocked(afterRun, "run:r-2", NOW + 4_000)).toBe(true);
    expect(reloadIsBlocked(afterRun, "run:r-1", NOW + 3_600_000)).toBe(true);
  });

  it("remembers a bounded number of tokens", () => {
    let record = nextReloadRecord(null, "t0", NOW);
    for (let index = 1; index < 20; index += 1) {
      record = nextReloadRecord(record, `t${index}`, NOW);
    }
    expect(record.tokens).toHaveLength(8);
    expect(record.tokens.at(-1)).toBe("t19");
  });
});

describe("modalStateOf", () => {
  const base = {
    nowMs: NOW,
    sawActiveRun: true,
    dismissedRunId: null,
    isProviderAdmin: false,
    onUpdatesTab: false,
  };

  it("shows nothing before the first answer and while idle", () => {
    expect(modalStateOf({ ...base, snapshot: null })).toEqual({ kind: "none" });
    expect(modalStateOf({ ...base, snapshot: snapshot({ phase: "idle" }) })).toEqual({
      kind: "none",
    });
    expect(modalStateOf({ ...base, snapshot: snapshot({ phase: "scheduled" }) })).toEqual({
      kind: "none",
    });
  });

  it("shows the running update, with or without the api", () => {
    expect(modalStateOf({ ...base, snapshot: snapshot({ phase: "running" }) })).toEqual({
      kind: "running",
      unreachable: false,
    });
    expect(
      modalStateOf({ ...base, snapshot: snapshot({ phase: "running" }, { apiReachable: false }) }),
    ).toEqual({
      kind: "running",
      unreachable: true,
    });
  });

  it("keeps the modal when the countdown ran out and the api went away", () => {
    const view = snapshot({ phase: "scheduled", startsAt: iso(-5) }, { apiReachable: false });
    expect(modalStateOf({ ...base, snapshot: view })).toEqual({
      kind: "running",
      unreachable: true,
    });
  });

  it("says the update succeeded only to a page that watched it", () => {
    const view = snapshot({ phase: "succeeded", runId: "r-1" });
    expect(modalStateOf({ ...base, snapshot: view })).toEqual({ kind: "succeeded" });
    expect(modalStateOf({ ...base, sawActiveRun: false, snapshot: view })).toEqual({
      kind: "none",
    });
    expect(modalStateOf({ ...base, dismissedRunId: "r-1", snapshot: view })).toEqual({
      kind: "none",
    });
  });

  it("says why a run failed, until it is dismissed", () => {
    for (const outcome of ["unchanged", "rolled_back"] as const) {
      const view = snapshot({ phase: "failed", runId: "r-1", outcome });
      expect(modalStateOf({ ...base, snapshot: view })).toEqual({ kind: "failed", outcome });
      expect(modalStateOf({ ...base, dismissedRunId: "r-1", snapshot: view })).toEqual({
        kind: "none",
      });
      // Another run's dismissal does not count.
      expect(modalStateOf({ ...base, dismissedRunId: "r-0", snapshot: view })).toEqual({
        kind: "failed",
        outcome,
      });
    }
  });

  it("does not bring up a long finished failure to a page that never saw it", () => {
    const old = snapshot({
      phase: "failed",
      runId: "r-1",
      outcome: "rolled_back",
      finishedAt: iso(-STALE_FAILURE_MS / 1000 - 60),
    });
    expect(modalStateOf({ ...base, sawActiveRun: false, snapshot: old })).toEqual({ kind: "none" });
    expect(modalStateOf({ ...base, sawActiveRun: true, snapshot: old })).toEqual({
      kind: "failed",
      outcome: "rolled_back",
    });
    const recent = snapshot({
      phase: "failed",
      runId: "r-1",
      outcome: "rolled_back",
      finishedAt: iso(-60),
    });
    expect(modalStateOf({ ...base, sawActiveRun: false, snapshot: recent }).kind).toBe("failed");
  });

  it("never dismisses 'needs attention' for a provider admin, but steps aside on the Updates tab", () => {
    const view = snapshot({
      phase: "failed",
      runId: "r-1",
      outcome: "needs_attention",
      finishedAt: iso(-3 * 86400),
    });
    const admin = { ...base, isProviderAdmin: true, sawActiveRun: false, dismissedRunId: "r-1" };
    expect(modalStateOf({ ...admin, snapshot: view })).toEqual({
      kind: "failed",
      outcome: "needs_attention",
    });
    expect(modalStateOf({ ...admin, onUpdatesTab: true, snapshot: view })).toEqual({
      kind: "none",
    });
  });

  it("lets everyone else dismiss it", () => {
    const view = snapshot({ phase: "failed", runId: "r-1", outcome: "needs_attention" });
    expect(modalStateOf({ ...base, snapshot: view })).toEqual({
      kind: "failed",
      outcome: "needs_attention",
    });
    expect(modalStateOf({ ...base, dismissedRunId: "r-1", snapshot: view })).toEqual({
      kind: "none",
    });
  });
});

describe("bannerStateOf", () => {
  const input = { nowMs: NOW, isProviderAdmin: false };

  it("shows the countdown for everyone and the running variant while it runs", () => {
    expect(bannerStateOf({ ...input, snapshot: snapshot({ phase: "scheduled" }) })).toEqual({
      kind: "scheduled",
    });
    expect(bannerStateOf({ ...input, snapshot: snapshot({ phase: "running" }) })).toEqual({
      kind: "running",
    });
    expect(bannerStateOf({ ...input, snapshot: snapshot({ phase: "idle" }) })).toEqual({
      kind: "none",
    });
    expect(bannerStateOf({ ...input, snapshot: snapshot({ phase: "succeeded" }) })).toEqual({
      kind: "none",
    });
    expect(bannerStateOf({ ...input, snapshot: null })).toEqual({ kind: "none" });
  });

  it("keeps telling a provider admin about a run that needs attention", () => {
    const view = snapshot({ phase: "failed", outcome: "needs_attention" });
    expect(bannerStateOf({ ...input, isProviderAdmin: true, snapshot: view })).toEqual({
      kind: "attention",
    });
    expect(bannerStateOf({ ...input, snapshot: view })).toEqual({ kind: "none" });
    expect(
      bannerStateOf({
        ...input,
        isProviderAdmin: true,
        snapshot: snapshot({ phase: "failed", outcome: "unchanged" }),
      }),
    ).toEqual({ kind: "none" });
  });
});
