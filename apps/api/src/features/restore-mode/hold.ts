import type { RestoreModeSnapshot } from "@restow/core";
import { ProblemError } from "../../problem.js";
import { apiRestoreModeGuard } from "./instance.js";

/**
 * Restore mode's job hold for what the api hands out itself (docs/STORAGE.md, "Restore mode and
 * progress markers"): the tasks agents and Proxmox VE nodes fetch with their heartbeat are rows
 * of the database, not queued jobs, so the worker's hold never reaches them. A task created before
 * the hold point is from the restored dump (a restore over a guest, an uninstall, a backup that
 * ran already in the timeline the database lost): it is cancelled with this explanation, never
 * delivered or delivered again.
 */
export const RESTORE_MODE_TASK_HOLD_MESSAGE =
  "The task is from before the database restore; start it again if it is still needed.";

export const RESTORE_MODE_UNKNOWN_PROBLEM = "urn:restow:problem:restore-mode-unknown";

/** The last restore mode this process read successfully (null: never read). */
let lastKnown: RestoreModeSnapshot | null = null;

/** Tests: forget the last read restore mode. */
export function forgetLastKnownRestoreMode(): void {
  lastKnown = null;
}

/**
 * The hold point while restore mode is on, null while it is off. Read through the api's guard
 * (cached for a few seconds). When the read fails, the hold fails closed like the worker's job
 * hold: restore mode last seen on keeps its hold point; restore mode never read, or seen on by
 * the guard's background read without a hold point here, answers 503 so nothing is handed out
 * (and nothing is cancelled on a guess); only restore mode last seen off holds nothing.
 */
export async function restoreModeTaskHoldBefore(): Promise<Date | null> {
  const guard = apiRestoreModeGuard();
  let state: RestoreModeSnapshot;
  try {
    state = await guard.restoreMode();
    lastKnown = state;
  } catch {
    // The guard's background read logs the failure (RestoreModeGuard.start).
    if (lastKnown?.active) {
      state = lastKnown;
    } else if (lastKnown && !guard.holding()) {
      return null;
    } else {
      throw new ProblemError(503, "Restore mode unknown", {
        type: RESTORE_MODE_UNKNOWN_PROBLEM,
        detail:
          "The restore mode could not be read from the database; no task is handed out until it can.",
      });
    }
  }
  return state.active ? state.holdJobsBefore : null;
}
