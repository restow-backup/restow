import type { StoredUpdateRelease } from "@restow/db";
import {
  type Run,
  type RunSummary,
  type StateView,
  maintenanceStatusOf,
} from "../../updater/protocol.js";
import type {
  MaintenanceView,
  ReleaseView,
  RunView,
  UpdaterAvailability,
  UpdaterView,
} from "./schemas.js";
import type { MaintenanceSummary } from "./state.js";

/** The documents of schemas.ts, built from the stored records and the updater's state. */

export function toReleaseView(release: StoredUpdateRelease): ReleaseView {
  return { ...release, digests: { ...release.digests } };
}

/** What every signed-in user may see of an announced or running maintenance. */
export function maintenanceViewOf(
  state: StateView | null,
  runningVersion: string | null,
  now: Date,
): MaintenanceView {
  const status = maintenanceStatusOf(state?.run ?? null, state?.phase ?? "idle", now);
  return { ...status, runningVersion };
}

/** The summary the version document carries while a maintenance is announced or running. */
export function maintenanceSummaryOf(state: StateView | null): MaintenanceSummary | null {
  if (!state?.run || (state.phase !== "scheduled" && state.phase !== "running")) {
    return null;
  }
  return {
    phase: state.phase,
    targetVersion: state.run.targetVersion,
    startsAt: state.run.startsAt,
  };
}

/** A run as an administrator sees it: the requester's address is kept, the IP address is not. */
export function toRunView(run: Run | RunSummary): RunView {
  return {
    ...run,
    log: "log" in run ? run.log : [],
    requestedBy: { userId: run.requestedBy.userId, label: run.requestedBy.label },
  };
}

/** The run to show: the current one, else the newest of the history. */
export function runToShow(state: StateView | null): RunView | null {
  if (!state) {
    return null;
  }
  const run = state.run ?? state.history[0] ?? null;
  return run ? toRunView(run) : null;
}

export interface UpdaterViewInput {
  state: StateView | null;
  demo: boolean;
  incompatible: boolean;
}

export function updaterViewOf({ state, demo, incompatible }: UpdaterViewInput): UpdaterView {
  const availability: UpdaterAvailability = demo
    ? "demo"
    : !state
      ? "unavailable"
      : state.phase === "scheduled" || state.phase === "running"
        ? "busy"
        : state.capabilities.ready
          ? "ready"
          : "blocked";
  return {
    state: availability,
    blockers: state?.capabilities.blockers ?? [],
    incompatible: incompatible && !demo,
    version: state?.updaterVersion ?? null,
    runner: state?.capabilities.runner ?? null,
    dumps: state?.capabilities.dumps ?? [],
    checkedAt: state?.capabilities.checkedAt ?? null,
  };
}
