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

/**
 * The hold point while restore mode is on, null while it is off. Read through the api's guard
 * (cached for a few seconds); a database that cannot be read holds nothing (like the job start
 * pause), the heartbeat must keep answering.
 */
export async function restoreModeTaskHoldBefore(): Promise<Date | null> {
  try {
    const state = await apiRestoreModeGuard().restoreMode();
    return state.active ? state.holdJobsBefore : null;
  } catch {
    return null;
  }
}
